#!/usr/bin/python3
"""One-window GNOME Wayland portal capture and input backend.

The backend exposes only selected-stream pixels and portal input. It does not
use window enumeration, OCR, accessibility APIs, clipboard access, X11, or a
fallback input path.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
import os
import threading
import time
import uuid

import dbus
from dbus.mainloop.glib import DBusGMainLoop
import gi

gi.require_version("GLib", "2.0")
gi.require_version("Gst", "1.0")
gi.require_version("GstApp", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import GLib, Gst, GstApp, GstVideo
from PIL import Image

from ei_sender import EiError, EiSender

PUBLIC_BUS = "org.freedesktop.portal.Desktop"
BACKEND_BUS = "org.freedesktop.impl.portal.desktop.gnome"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"
BACKEND_REMOTE = "org.freedesktop.impl.portal.RemoteDesktop"
BACKEND_SCREENCAST = "org.freedesktop.impl.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
BACKEND_REQUEST = "org.freedesktop.impl.portal.Request"
SESSION = "org.freedesktop.portal.Session"
PROPERTIES = "org.freedesktop.DBus.Properties"
WINDOW = 2
KEYBOARD = 1
POINTER = 2
DEVICES = KEYBOARD | POINTER
CURSOR_EMBEDDED = 2
BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112}
KEYSYMS = {
    "enter": 0xFF0D,
    "escape": 0xFF1B,
    "tab": 0xFF09,
    "backspace": 0xFF08,
    "space": 0x20,
}


class PortalError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def plain(value):
    if isinstance(value, dbus.Dictionary):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (dbus.Array, dbus.Struct, list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, (dbus.String, dbus.ObjectPath)):
        return str(value)
    if isinstance(value, dbus.Boolean):
        return bool(value)
    if isinstance(value, (dbus.Int16, dbus.Int32, dbus.Int64, dbus.UInt16, dbus.UInt32, dbus.UInt64, dbus.Byte)):
        return int(value)
    return value


def _property(bus, bus_name: str, interface: str, name: str) -> int:
    obj = bus.get_object(bus_name, PORTAL_PATH)
    return int(dbus.Interface(obj, PROPERTIES).Get(interface, name))


def capability_snapshot(bus) -> dict:
    return {
        "public": {
            "devices": _property(bus, PUBLIC_BUS, REMOTE, "AvailableDeviceTypes"),
            "sources": _property(bus, PUBLIC_BUS, SCREENCAST, "AvailableSourceTypes"),
            "cursor_modes": _property(bus, PUBLIC_BUS, SCREENCAST, "AvailableCursorModes"),
            "remote_version": _property(bus, PUBLIC_BUS, REMOTE, "version"),
            "screencast_version": _property(bus, PUBLIC_BUS, SCREENCAST, "version"),
        },
        "gnome_backend": {
            "devices": _property(bus, BACKEND_BUS, BACKEND_REMOTE, "AvailableDeviceTypes"),
            "sources": _property(bus, BACKEND_BUS, BACKEND_SCREENCAST, "AvailableSourceTypes"),
            "cursor_modes": _property(bus, BACKEND_BUS, BACKEND_SCREENCAST, "AvailableCursorModes"),
            "remote_version": _property(bus, BACKEND_BUS, BACKEND_REMOTE, "version"),
            "screencast_version": _property(bus, BACKEND_BUS, BACKEND_SCREENCAST, "version"),
        },
    }


def validate_capabilities(snapshot: dict) -> None:
    public = snapshot["public"]
    backend = snapshot["gnome_backend"]
    for name in ("devices", "sources", "cursor_modes"):
        if public[name] != 7 or backend[name] != 7 or public[name] != backend[name]:
            raise PortalError("CAPABILITY_MISMATCH", f"portal capability {name} is not matching mask 7", snapshot)
    if public["remote_version"] < 2 or backend["remote_version"] < 2:
        raise PortalError("UNSUPPORTED_PORTAL", "RemoteDesktop version 2 or newer is required")
    if public["screencast_version"] < 5 or backend["screencast_version"] < 5:
        raise PortalError("UNSUPPORTED_PORTAL", "ScreenCast version 5 or newer is required")


@dataclass
class PixelState:
    state_id: str
    image: Image.Image
    full_digest: str
    stream_identity: str
    geometry_fingerprint: str
    logical_width: int
    logical_height: int
    image_width: int
    image_height: int
    captured_at: float


class FrameStream:
    def __init__(self, fd: int, node_id: int, serial: int | None):
        Gst.init(None)
        self.fd = fd
        self.node_id = node_id
        self.serial = serial
        self._closed = False
        self._capture_lock = threading.Lock()
        self.pipeline = Gst.Pipeline.new("pixel-cua-portal")
        self.source = Gst.ElementFactory.make("pipewiresrc", "source")
        self.convert = Gst.ElementFactory.make("videoconvert", "convert")
        self.filter = Gst.ElementFactory.make("capsfilter", "rgb-filter")
        self.sink = Gst.ElementFactory.make("appsink", "sink")
        if not all((self.pipeline, self.source, self.convert, self.filter, self.sink)):
            self.close()
            raise PortalError("PIPEWIRE_UNAVAILABLE", "required GStreamer PipeWire elements are unavailable")
        self.source.set_property("fd", fd)
        if self.source.find_property("keepalive-time"):
            # GNOME window streams can be damage-driven. Ask pipewiresrc to
            # periodically expose its newest buffer so an explicit observe is bounded.
            self.source.set_property("keepalive-time", 250)
        if serial is not None and self.source.find_property("target-object"):
            self.source.set_property("target-object", str(serial))
        else:
            self.source.set_property("path", str(node_id))
        self.filter.set_property("caps", Gst.Caps.from_string("video/x-raw,format=RGB"))
        self.sink.set_property("sync", False)
        self.sink.set_property("drop", True)
        self.sink.set_property("max-buffers", 1)
        for element in (self.source, self.convert, self.filter, self.sink):
            self.pipeline.add(element)
        if not self.source.link(self.convert) or not self.convert.link(self.filter) or not self.filter.link(self.sink):
            self.close()
            raise PortalError("PIPEWIRE_UNAVAILABLE", "could not link the selected-stream capture pipeline")
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            self.close()
            raise PortalError("PIPEWIRE_UNAVAILABLE", "could not start the selected-stream capture pipeline")

    @staticmethod
    def _image_from_sample(sample) -> Image.Image:
        buffer = sample.get_buffer()
        caps = sample.get_caps()
        info = GstVideo.VideoInfo.new_from_caps(caps)
        ok, mapped = buffer.map(Gst.MapFlags.READ)
        if not ok:
            raise PortalError("CAPTURE_FAILED", "could not map the selected-stream frame")
        try:
            width, height = int(info.width), int(info.height)
            stride = int(info.stride[0])
            return Image.frombytes("RGB", (width, height), bytes(mapped.data), "raw", "RGB", stride).copy()
        finally:
            buffer.unmap(mapped)

    def _ensure_healthy_geometry(self, expected_size: tuple[int, int]) -> None:
        if self._closed or self.pipeline is None or self.sink is None:
            raise PortalError("CAPABILITY_REVOKED", "frame stream is closed")
        bus = self.pipeline.get_bus()
        message = bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.EOS) if bus else None
        if message is not None:
            raise PortalError("CAPABILITY_REVOKED", "selected stream ended or reported an error")
        state_change, current_state, _pending = self.pipeline.get_state(0)
        if state_change == Gst.StateChangeReturn.FAILURE or current_state == Gst.State.NULL:
            raise PortalError("CAPABILITY_REVOKED", "selected stream pipeline is not active")
        pad = self.sink.get_static_pad("sink")
        caps = pad.get_current_caps() if pad else None
        if caps is None or caps.get_size() < 1:
            raise PortalError("STALE_GEOMETRY", "selected stream has no current negotiated geometry")
        info = GstVideo.VideoInfo.new_from_caps(caps)
        actual_size = (int(info.width), int(info.height))
        if actual_size != expected_size:
            raise PortalError(
                "STALE_GEOMETRY",
                "selected-stream capture geometry changed",
                {"expected": list(expected_size), "actual": list(actual_size)},
            )

    def capture(self, timeout_seconds: float = 5.0) -> Image.Image:
        with self._capture_lock:
            if self._closed or self.pipeline is None or self.sink is None:
                raise PortalError("CAPABILITY_REVOKED", "frame stream is closed")
            sample = self.sink.try_pull_sample(int(timeout_seconds * Gst.SECOND))
            if sample is None:
                raise PortalError("CAPTURE_TIMEOUT", "selected stream did not produce a frame")
            try:
                return self._image_from_sample(sample)
            finally:
                sample = None

    def capture_or_unchanged(self, prior: Image.Image, timeout_seconds: float = 0.75) -> tuple[Image.Image, bool]:
        """Return a new sample, or prior bytes when a healthy stream emits none."""
        with self._capture_lock:
            if self._closed or self.pipeline is None or self.sink is None:
                raise PortalError("CAPABILITY_REVOKED", "frame stream is closed")
            sample = self.sink.try_pull_sample(int(timeout_seconds * Gst.SECOND))
            if sample is not None:
                try:
                    return self._image_from_sample(sample), True
                finally:
                    sample = None
            self._ensure_healthy_geometry(prior.size)
            return prior.copy(), False

    def refresh_capture(self, prior: Image.Image, timeout_seconds: float = 5.0) -> tuple[Image.Image, bool]:
        """Reconnect the selected PipeWire node to request its current full buffer."""
        with self._capture_lock:
            if self._closed or self.pipeline is None or self.sink is None:
                raise PortalError("CAPABILITY_REVOKED", "frame stream is closed")
            if self.pipeline.set_state(Gst.State.READY) == Gst.StateChangeReturn.FAILURE:
                raise PortalError("CAPTURE_REFRESH_FAILED", "could not reset the selected-stream pipeline")
            self.pipeline.get_state(2 * Gst.SECOND)
            if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise PortalError("CAPTURE_REFRESH_FAILED", "could not reconnect the selected-stream pipeline")
            sample = self.sink.try_pull_sample(int(timeout_seconds * Gst.SECOND))
            if sample is not None:
                try:
                    image = self._image_from_sample(sample)
                finally:
                    sample = None
                if image.size != prior.size:
                    raise PortalError(
                        "STALE_GEOMETRY",
                        "selected-stream capture geometry changed during refresh",
                        {"expected": list(prior.size), "actual": list(image.size)},
                    )
                return image, True
            self._ensure_healthy_geometry(prior.size)
            return prior.copy(), False

    def close(self) -> None:
        if getattr(self, "_closed", False):
            return
        self._closed = True
        pipeline = getattr(self, "pipeline", None)
        if pipeline is not None:
            pipeline.set_state(Gst.State.NULL)
            pipeline.get_state(2 * Gst.SECOND)
        self.sink = None
        self.filter = None
        self.convert = None
        self.source = None
        self.pipeline = None
        fd = getattr(self, "fd", -1)
        self.fd = -1
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


class PortalSession:
    def __init__(self, timeout_seconds: int = 900):
        DBusGMainLoop(set_as_default=True)
        self.bus = dbus.SessionBus()
        portal = self.bus.get_object(PUBLIC_BUS, PORTAL_PATH)
        self.remote = dbus.Interface(portal, REMOTE)
        self.screencast = dbus.Interface(portal, SCREENCAST)
        self.timeout_seconds = timeout_seconds
        self.session_handle: str | None = None
        self.active_request: str | None = None
        self.run_paths: list[str] = []
        self.request_paths: list[str] = []
        self.stopping = threading.Event()
        self.closed = threading.Event()
        self._stop_lock = threading.Lock()

    def _token(self, prefix: str) -> str:
        return f"pixelcua_{prefix}_{uuid.uuid4().hex}"

    def _expected_path(self, token: str) -> str:
        sender = self.bus.get_unique_name()[1:].replace(".", "_")
        return f"/org/freedesktop/portal/desktop/request/{sender}/{token}"

    def _request(self, method, args: tuple, prefix: str, options: dict | None = None) -> dict:
        if self.stopping.is_set():
            raise PortalError("CAPABILITY_REVOKED", "portal session is stopping")
        token = self._token(prefix)
        expected = self._expected_path(token)
        request_options = dict(options or {})
        request_options["handle_token"] = dbus.String(token)
        request_options = dbus.Dictionary(request_options, signature="sv")
        result: dict = {}
        response_ready = threading.Event()

        def response(code, values):
            if "code" not in result:
                result["code"] = int(code)
                result["values"] = values
            response_ready.set()

        self.bus.add_signal_receiver(response, signal_name="Response", dbus_interface=REQUEST, path=expected)
        try:
            returned = str(method(*args, request_options))
            self.active_request = returned
            self.run_paths.append(returned)
            self.request_paths.append(returned)
            if returned != expected:
                self._close_request(returned)
                raise PortalError("REQUEST_PATH_MISMATCH", "portal returned an unexpected request path")

            if "code" not in result and not response_ready.wait(self.timeout_seconds):
                self._close_request(returned)
                raise PortalError("CONSENT_TIMEOUT", "portal request timed out")
            code = int(result.get("code", 2))
            if code != 0:
                label = "user cancelled" if code == 1 else "portal ended request"
                raise PortalError("USER_CANCELLED", label)
            return plain(result.get("values", {}))
        finally:
            self.bus.remove_signal_receiver(response, signal_name="Response", dbus_interface=REQUEST, path=expected)
            self.active_request = None

    def _close_request(self, path: str) -> None:
        try:
            dbus.Interface(self.bus.get_object(PUBLIC_BUS, path), REQUEST).Close()
        except dbus.DBusException:
            pass

    def start(self) -> dict:
        snapshot = capability_snapshot(self.bus)
        validate_capabilities(snapshot)
        session_token = self._token("session")
        created = self._request(
            self.remote.CreateSession,
            (),
            "create",
            {"session_handle_token": dbus.String(session_token)},
        )
        handle = created.get("session_handle")
        if not handle:
            raise PortalError("BAD_PORTAL_RESULT", "portal omitted the session handle")
        self.session_handle = str(handle)
        self.run_paths.append(self.session_handle)
        self.bus.add_signal_receiver(self._on_closed, signal_name="Closed", dbus_interface=SESSION, path=self.session_handle)
        session = dbus.ObjectPath(self.session_handle)
        self._request(
            self.remote.SelectDevices,
            (session,),
            "devices",
            {"types": dbus.UInt32(DEVICES), "persist_mode": dbus.UInt32(0)},
        )
        self._request(
            self.screencast.SelectSources,
            (session,),
            "sources",
            {"types": dbus.UInt32(WINDOW), "multiple": dbus.Boolean(False), "cursor_mode": dbus.UInt32(CURSOR_EMBEDDED)},
        )
        started = self._request(self.remote.Start, (session, dbus.String("")), "start")
        devices = int(started.get("devices", 0))
        streams = started.get("streams", [])
        if devices != DEVICES:
            raise PortalError("BAD_DEVICE_GRANT", f"portal returned device mask {devices}; exact mask 3 is required")
        if "restore_token" in started:
            raise PortalError("PERSISTENCE_REFUSED", "non-persistent session unexpectedly returned a restore token")
        if len(streams) != 1 or not isinstance(streams[0], (list, tuple)) or len(streams[0]) != 2:
            raise PortalError("BAD_STREAM_GRANT", "exactly one selected stream is required")
        node_id = int(streams[0][0])
        props = dict(streams[0][1])
        if int(props.get("source_type", 0)) != WINDOW:
            raise PortalError("BAD_STREAM_GRANT", "selected source is not one window")
        logical_size = plain(props.get("size"))
        if not isinstance(logical_size, list) or len(logical_size) != 2 or min(map(int, logical_size)) <= 0:
            raise PortalError("BAD_STREAM_GRANT", "selected window did not provide valid logical geometry")
        mapping_id = plain(props.get("mapping_id"))
        if not isinstance(mapping_id, str) or not mapping_id:
            raise PortalError("BAD_STREAM_GRANT", "selected window did not provide an EIS mapping ID")
        pipewire_fd = -1
        eis_fd = -1
        try:
            fd_value = self.screencast.OpenPipeWireRemote(session, dbus.Dictionary({}, signature="sv"))
            pipewire_fd = int(fd_value.take()) if hasattr(fd_value, "take") else os.dup(int(fd_value))
            eis_value = self.remote.ConnectToEIS(session, dbus.Dictionary({}, signature="sv"))
            eis_fd = int(eis_value.take()) if hasattr(eis_value, "take") else os.dup(int(eis_value))
        except Exception:
            for owned_fd in (pipewire_fd, eis_fd):
                if owned_fd >= 0:
                    os.close(owned_fd)
            raise
        return {
            "capabilities": snapshot,
            "node_id": node_id,
            "logical_size": [int(logical_size[0]), int(logical_size[1])],
            "opaque_id": plain(props.get("id")),
            "mapping_id": mapping_id,
            "pipewire_serial": int(props["pipewire-serial"]) if "pipewire-serial" in props else None,
            "fd": pipewire_fd,
            "eis_fd": eis_fd,
        }

    def _on_closed(self, _details) -> None:
        self.stopping.set()
        self.closed.set()

    def _exists(self, bus_name: str, path: str) -> bool:
        try:
            obj = self.bus.get_object(bus_name, path, introspect=False)
            xml = str(dbus.Interface(obj, "org.freedesktop.DBus.Introspectable").Introspect())
            return "<interface" in xml
        except dbus.DBusException:
            return False

    def stop(self) -> dict:
        with self._stop_lock:
            self.stopping.set()
            if self.active_request:
                self._close_request(self.active_request)
            close_called = False
            if self.session_handle:
                try:
                    dbus.Interface(self.bus.get_object(PUBLIC_BUS, self.session_handle), SESSION).Close()
                    close_called = True
                except dbus.DBusException:
                    pass
            deadline = time.monotonic() + 2
            context = GLib.MainContext.default()
            while time.monotonic() < deadline and not self.closed.is_set():
                while context.pending():
                    context.iteration(False)
                time.sleep(0.02)
            backend_closed: list[str] = []
            for path in reversed(list(dict.fromkeys(self.request_paths))):
                if not self._exists(BACKEND_BUS, path):
                    continue
                try:
                    dbus.Interface(self.bus.get_object(BACKEND_BUS, path, introspect=False), BACKEND_REQUEST).Close()
                    backend_closed.append(path.rsplit("/", 1)[-1])
                except dbus.DBusException as error:
                    raise PortalError("CLEANUP_FAILED", f"backend request cleanup failed: {error.get_dbus_name()}")
            checks = [(name, path) for name in (PUBLIC_BUS, BACKEND_BUS) for path in dict.fromkeys(self.run_paths)]
            deadline = time.monotonic() + 3
            remaining: list[str] = []
            while time.monotonic() < deadline:
                remaining = [f"{name}:{path.rsplit('/', 1)[-1]}" for name, path in checks if self._exists(name, path)]
                if not remaining:
                    break
                time.sleep(0.05)
            if remaining:
                raise PortalError("CLEANUP_FAILED", "run-owned portal objects remain", {"remaining": remaining})
            return {
                "sessionCloseCalled": close_called,
                "closedSignal": self.closed.is_set(),
                "backendRequestsClosed": backend_closed,
                "runObjectsAbsent": True,
            }


class PortalRuntime:
    def __init__(self):
        self.portal: PortalSession | None = None
        self.stream: FrameStream | None = None
        self.sender: EiSender | None = None
        self.started = False
        self.stopped = threading.Event()
        self.states: dict[str, PixelState] = {}
        self.latest_state_id: str | None = None
        self.focus_proof_state_id: str | None = None
        self.stream_identity = ""
        self.logical_size = (0, 0)
        self.node_id = 0
        self._input_lock = threading.RLock()

    def start(self, timeout_seconds: int = 900) -> dict:
        if self.started and not self.stopped.is_set():
            raise PortalError("ALREADY_ACTIVE", "one portal session is already active")
        self.portal = PortalSession(timeout_seconds)
        try:
            grant = self.portal.start()
            identity_source = "|".join(str(grant.get(k)) for k in ("node_id", "opaque_id", "mapping_id", "pipewire_serial"))
            self.stream_identity = sha256(identity_source.encode()).hexdigest()
            self.logical_size = tuple(grant["logical_size"])
            self.node_id = int(grant["node_id"])
            pipewire_fd = int(grant["fd"])
            grant["fd"] = -1
            self.stream = FrameStream(pipewire_fd, self.node_id, grant.get("pipewire_serial"))
            try:
                eis_fd = int(grant["eis_fd"])
                grant["eis_fd"] = -1
                self.sender = EiSender(eis_fd, str(grant["mapping_id"]))
            except EiError as error:
                raise PortalError("INPUT_UNAVAILABLE", str(error)) from error
            self.started = True
            self.stopped.clear()
            return {
                "active": True,
                "eis": self.sender.metadata(),
                "streamIdentity": self.stream_identity,
                "logicalSize": list(self.logical_size),
                "sourceType": "window",
                "streamCount": 1,
                "deviceMask": DEVICES,
                "persistent": False,
                "inputTransport": "portal-eis",
                "mappingIdMatched": True,
                "cursorMode": "embedded-system-cursor",
                "windowBorderOverlay": "unavailable-standard-portal",
                "pixelsRetainedOnDisk": False,
            }
        except Exception:
            try:
                self.stop()
            except Exception:
                pass
            raise

    def _ensure_active(self) -> None:
        if not self.started or self.stopped.is_set() or not self.portal or self.portal.stopping.is_set() or not self.stream or not self.sender:
            raise PortalError("CAPABILITY_REVOKED", "portal capability is not active")

    def _geometry(self, image: Image.Image) -> str:
        value = f"{self.stream_identity}|{self.logical_size[0]}x{self.logical_size[1]}|{image.width}x{image.height}"
        return sha256(value.encode()).hexdigest()

    def _new_state(self, image: Image.Image) -> PixelState:
        state_id = "s_" + uuid.uuid4().hex
        pixels = image.tobytes()
        state = PixelState(
            state_id=state_id,
            image=image,
            full_digest=sha256(pixels).hexdigest(),
            stream_identity=self.stream_identity,
            geometry_fingerprint=self._geometry(image),
            logical_width=self.logical_size[0],
            logical_height=self.logical_size[1],
            image_width=image.width,
            image_height=image.height,
            captured_at=time.time(),
        )
        self.states = {state_id: state}
        self.latest_state_id = state_id
        return state

    @staticmethod
    def _model_image(image: Image.Image, max_dimension: int = 1024) -> tuple[Image.Image, str]:
        result = image.copy()
        if max(result.size) > max_dimension:
            scale = max_dimension / max(result.size)
            result = result.resize((max(1, round(result.width * scale)), max(1, round(result.height * scale))), Image.Resampling.LANCZOS)
        output = BytesIO()
        result.save(output, format="PNG", optimize=True)
        return result, base64.b64encode(output.getvalue()).decode("ascii")

    @staticmethod
    def _frame_provenance(prior: PixelState | None, state: PixelState, sample_available: bool) -> dict:
        if prior is None:
            return {
                "pipeWireSampleStatus": "new-sample",
                "frameBytesStatus": "initial-captured-bytes",
                "reusedFromStateId": None,
            }
        bytes_reused = prior.full_digest == state.full_digest
        return {
            "pipeWireSampleStatus": "new-sample" if sample_available else "no-new-sample",
            "frameBytesStatus": "reused-identical-bytes" if bytes_reused else "changed-bytes",
            "reusedFromStateId": prior.state_id if bytes_reused else None,
        }

    def _observe_successor(self, prior: PixelState) -> tuple[Image.Image, bool, bool, bool]:
        """Get an observe successor without failing on a healthy no-damage stream.

        A window stream can have no damage after an action. In that case the
        newest safe proof is a fresh immutable state containing the same bytes.
        The refresh is best effort: a bounded refresh timeout must not turn a
        healthy unchanged stream into a failed observe.
        """
        image, sample_available = self.stream.capture_or_unchanged(prior.image, 1.25)
        refresh_attempted = False
        refresh_sample_available = False
        if sha256(image.tobytes()).hexdigest() == prior.full_digest:
            refresh_attempted = True
            try:
                image, refresh_sample_available = self.stream.refresh_capture(prior.image)
            except PortalError as error:
                if error.code not in {"CAPTURE_TIMEOUT", "CAPTURE_REFRESH_FAILED"}:
                    raise
                # Confirm that the selected stream is still healthy and that
                # negotiated geometry still matches before reusing bytes.
                self.stream._ensure_healthy_geometry(prior.image.size)
                image, refresh_sample_available = prior.image.copy(), False
            sample_available = refresh_sample_available
        return image, sample_available, refresh_attempted, refresh_sample_available

    def capture(self, max_dimension: int = 1024) -> dict:
        self._ensure_active()
        prior = self.states.get(self.latest_state_id) if self.latest_state_id else None
        refresh_attempted = False
        refresh_sample_available = False
        if prior is None:
            image = self.stream.capture()
            sample_available = True
        else:
            image, sample_available, refresh_attempted, refresh_sample_available = self._observe_successor(prior)
        state = self._new_state(image)
        model, encoded = self._model_image(image, max_dimension)
        result = self._state_result(state, model, encoded)
        result.update(self._frame_provenance(prior, state, sample_available))
        result.update({
            "refreshAttempted": refresh_attempted,
            "refreshSampleAvailable": refresh_sample_available,
            "visualSuccessorProof": "new-bytes" if prior is None or prior.full_digest != state.full_digest else "reused-bytes",
        })
        return result

    def _state_result(self, state: PixelState, model: Image.Image, encoded: str) -> dict:
        return {
            "stateId": state.state_id,
            "streamIdentity": state.stream_identity,
            "geometryFingerprint": state.geometry_fingerprint,
            "logicalSize": [state.logical_width, state.logical_height],
            "captureSize": [state.image_width, state.image_height],
            "imageSize": [model.width, model.height],
            "fullFrameSha256": state.full_digest,
            "capturedAt": state.captured_at,
            "mimeType": "image/png",
            "imageBase64": encoded,
        }

    @staticmethod
    def _diff(before: Image.Image, after: Image.Image, threshold: int = 24) -> dict:
        if before.size != after.size:
            return {"geometryChanged": True, "changedFraction": 1.0, "meanAbsoluteDifference": 255.0}
        a, b = before.tobytes(), after.tobytes()
        pixels = before.width * before.height
        changed = 0
        total = 0
        for offset in range(0, len(a), 3):
            d0 = abs(a[offset] - b[offset])
            d1 = abs(a[offset + 1] - b[offset + 1])
            d2 = abs(a[offset + 2] - b[offset + 2])
            total += d0 + d1 + d2
            if max(d0, d1, d2) > threshold:
                changed += 1
        return {
            "geometryChanged": False,
            "changedFraction": changed / max(1, pixels),
            "meanAbsoluteDifference": total / max(1, pixels * 3),
        }

    @staticmethod
    def _target_region(state: PixelState, action: dict) -> tuple[int, int, int, int] | None:
        """Return a capture-pixel guard region around one pointer target."""
        if action.get("type") not in ("move", "click"):
            return None
        model_size = list(action.get("imageSize") or [])
        if len(model_size) != 2 or min(model_size) <= 0:
            raise PortalError("BAD_ACTION", "model image geometry is missing")
        x = float(action.get("x"))
        y = float(action.get("y"))
        if x < 0 or y < 0 or x >= model_size[0] or y >= model_size[1]:
            raise PortalError("COORDINATE_OUT_OF_BOUNDS", "pointer coordinate is outside the selected stream image")
        center_x = (x + 0.5) * state.image_width / model_size[0]
        center_y = (y + 0.5) * state.image_height / model_size[1]
        # Guard about 20 model pixels around the target. This detects a moved
        # or replaced control without treating an unrelated spinner as stale.
        radius_x = max(12, round(20 * state.image_width / model_size[0]))
        radius_y = max(12, round(20 * state.image_height / model_size[1]))
        return (
            max(0, round(center_x) - radius_x),
            max(0, round(center_y) - radius_y),
            min(state.image_width, round(center_x) + radius_x + 1),
            min(state.image_height, round(center_y) + radius_y + 1),
        )

    @classmethod
    def _target_diff(cls, before: Image.Image, after: Image.Image, region: tuple[int, int, int, int] | None) -> dict | None:
        if region is None:
            return None
        if before.size != after.size:
            return {"geometryChanged": True, "changedFraction": 1.0, "meanAbsoluteDifference": 255.0, "captureRegion": list(region)}
        result = cls._diff(before.crop(region), after.crop(region))
        result["captureRegion"] = list(region)
        return result

    def _get_state(self, state_id: str) -> PixelState:
        state = self.states.get(state_id)
        if not state:
            raise PortalError("UNKNOWN_STATE", "state is missing or no longer retained")
        if state_id != self.latest_state_id:
            raise PortalError("STALE_STATE", "only the newest state can authorize input")
        return state

    def _release_inputs(self) -> dict:
        if not self.sender:
            return {"released": True, "failures": []}
        return self.sender.release_inputs()

    def _move(self, state: PixelState, x: float, y: float, model_size: list[int]) -> dict:
        if len(model_size) != 2 or min(model_size) <= 0:
            raise PortalError("BAD_ACTION", "model image geometry is missing")
        if x < 0 or y < 0 or x >= model_size[0] or y >= model_size[1]:
            raise PortalError("COORDINATE_OUT_OF_BOUNDS", "pointer coordinate is outside the selected stream image")
        x_fraction = (x + 0.5) / model_size[0]
        y_fraction = (y + 0.5) / model_size[1]
        try:
            mapped = self.sender.move_fraction(x_fraction, y_fraction)
        except EiError as error:
            raise PortalError("INPUT_UNAVAILABLE", str(error)) from error
        mapped.update({
            "logicalX": x_fraction * state.logical_width,
            "logicalY": y_fraction * state.logical_height,
            "streamNodeBound": True,
        })
        return mapped

    def _click(self, button_name: str) -> dict:
        button = BUTTONS.get(button_name)
        if button is None:
            raise PortalError("BAD_ACTION", "button must be left, middle, or right")
        try:
            self.sender.click(button)
        except EiError as error:
            raise PortalError("INPUT_UNAVAILABLE", str(error)) from error
        return {"kind": "click", "button": button_name}

    def _send_keysym(self, keysym: int) -> str:
        try:
            return self.sender.keysym(keysym)
        except EiError as error:
            raise PortalError("INPUT_UNAVAILABLE", str(error)) from error

    def act(self, state_id: str, action: dict, max_dimension: int = 1024) -> dict:
        self._ensure_active()
        state = self._get_state(state_id)
        # Keep this pull short. appsink already retains only the newest buffer.
        # The local target guard below makes dynamic streams usable without
        # weakening exact stream or geometry binding.
        current, pre_frame_fresh = self.stream.capture_or_unchanged(state.image, 0.12)
        if self._geometry(current) != state.geometry_fingerprint:
            self.stop()
            raise PortalError("STALE_GEOMETRY", "selected-stream geometry changed; portal capability was revoked")
        pre_diff = self._diff(state.image, current)
        target_region = self._target_region(state, action)
        target_diff = self._target_diff(state.image, current, target_region)
        if target_diff and (target_diff["changedFraction"] > 0.02 or target_diff["meanAbsoluteDifference"] > 3.0):
            raise PortalError(
                "STALE_TARGET",
                "pixels near the pointer target changed; observe the newest selected-stream state",
                {"targetDiff": target_diff, "fullFrameDiff": pre_diff},
            )
        rebased = state.full_digest != sha256(current.tobytes()).hexdigest()
        kind = action.get("type")
        delivery: dict
        try:
            if kind in ("move", "click"):
                mapped = self._move(state, float(action.get("x")), float(action.get("y")), list(action.get("imageSize") or []))
                delivery = {
                    "kind": kind,
                    "mappedLogicalCoordinate": [mapped["logicalX"], mapped["logicalY"]],
                    "mappedEisCoordinate": [mapped["eisX"], mapped["eisY"]],
                    "eisRegion": mapped["region"],
                    "mappingIdMatched": mapped["mappingIdMatched"],
                    "streamNodeBound": True,
                    "inputTransport": "portal-eis",
                }
                if kind == "click":
                    if self.stopped.is_set():
                        raise PortalError("EMERGENCY_STOPPED", "input stopped before click")
                    delivery.update(self._click(str(action.get("button", "left"))))
            elif kind == "type":
                if self.focus_proof_state_id != state_id:
                    raise PortalError("FOCUS_PROOF_REQUIRED", "keyboard input requires a fresh selected-stream click state")
                text = action.get("text")
                if not isinstance(text, str) or not text or len(text) > 64 or any(ord(ch) < 0x20 or ord(ch) > 0x7E for ch in text):
                    raise PortalError("BAD_ACTION", "typed text must be 1 to 64 printable ASCII characters")
                if self.stopped.is_set():
                    raise PortalError("EMERGENCY_STOPPED", "input stopped")
                try:
                    keyboard_transport = self.sender.type_text(text)
                except EiError as error:
                    raise PortalError("INPUT_UNAVAILABLE", str(error)) from error
                delivery = {
                    "kind": "type",
                    "characters": len(text),
                    "textSha256": sha256(text.encode()).hexdigest(),
                    "inputTransport": "portal-eis",
                    "keyboardTransport": keyboard_transport,
                }
            elif kind == "key":
                if self.focus_proof_state_id != state_id:
                    raise PortalError("FOCUS_PROOF_REQUIRED", "keyboard input requires a fresh selected-stream click state")
                name = str(action.get("key", "")).lower()
                if name not in KEYSYMS:
                    raise PortalError("BAD_ACTION", "key must be enter, escape, tab, backspace, or space")
                keyboard_transport = self._send_keysym(KEYSYMS[name])
                delivery = {
                    "kind": "key",
                    "key": name,
                    "inputTransport": "portal-eis",
                    "keyboardTransport": keyboard_transport,
                }
            else:
                raise PortalError("BAD_ACTION", "action type must be move, click, type, or key")
        except Exception:
            release = self._release_inputs()
            if not release["released"]:
                try:
                    self.stop()
                finally:
                    raise PortalError("INPUT_RELEASE_FAILED", "input release failed; portal capability was revoked", release)
            raise
        if self.stopped.wait(0.08 if kind == "move" else 0.15):
            raise PortalError("EMERGENCY_STOPPED", "input stopped")
        after, post_frame_fresh = self.stream.capture_or_unchanged(current, 0.35)
        if self._geometry(after) != state.geometry_fingerprint:
            self.stop()
            raise PortalError("STALE_GEOMETRY", "selected-stream geometry changed after input; capability was revoked")
        successor = self._new_state(after)
        if kind == "click":
            self.focus_proof_state_id = successor.state_id
        elif kind not in ("type", "key"):
            self.focus_proof_state_id = None
        model, encoded = self._model_image(after, max_dimension)
        post_diff = self._diff(current, after)
        result = self._state_result(successor, model, encoded)
        result.update({
            "delivery": delivery,
            "preActionDiff": pre_diff,
            "targetGuardDiff": target_diff,
            "preActionRebasedToNewestFrame": rebased,
            "preActionFrameSha256": sha256(current.tobytes()).hexdigest(),
            "stalePolicy": "target-region" if target_region else "fresh-focus-proof",
            "postActionDiff": post_diff,
            "preActionFrameFresh": pre_frame_fresh,
            "postActionFrameFresh": post_frame_fresh,
            "visibleChangeClaimed": bool(post_frame_fresh and post_diff["changedFraction"] > 0),
            "successorBasis": "new-pipewire-sample" if post_frame_fresh else "healthy-cached-frame",
            "inputsReleased": self.sender.inputs_released,
            "visualSuccessorProof": "new-bytes" if sha256(current.tobytes()).hexdigest() != successor.full_digest else "reused-bytes",
        })
        result.update(self._frame_provenance(state, successor, post_frame_fresh))
        return result

    def stop(self) -> dict:
        self.stopped.set()
        release = self._release_inputs()
        stream = self.stream
        self.stream = None
        if stream:
            stream.close()
        sender = self.sender
        self.sender = None
        if sender:
            sender.close()
        cleanup = {"runObjectsAbsent": True}
        portal = self.portal
        if portal:
            cleanup = portal.stop()
        self.states.clear()
        self.latest_state_id = None
        self.focus_proof_state_id = None
        self.started = False
        self.portal = None
        return {
            "stopped": True,
            "inputsReleased": release["released"] or cleanup.get("runObjectsAbsent", False),
            "releaseFailures": release["failures"],
            "pixelsRetainedInHelper": False,
            "pipelineClosed": True,
            "portalCleanup": cleanup,
        }
