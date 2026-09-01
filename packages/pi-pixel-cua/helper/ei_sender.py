#!/usr/bin/python3
"""Minimal libei sender bound to one portal ScreenCast mapping ID."""
from __future__ import annotations

import ctypes
from ctypes.util import find_library
import mmap
import os
import select
import threading
import time


class EiError(RuntimeError):
    pass


# libei 1.6 enum ei_event_type and enum ei_device_capability.
EI_EVENT_CONNECT = 1
EI_EVENT_DISCONNECT = 2
EI_EVENT_SEAT_ADDED = 3
EI_EVENT_SEAT_REMOVED = 4
EI_EVENT_DEVICE_ADDED = 5
EI_EVENT_DEVICE_REMOVED = 6
EI_EVENT_DEVICE_PAUSED = 7
EI_EVENT_DEVICE_RESUMED = 8
EI_CAP_POINTER_ABSOLUTE = 1 << 1
EI_CAP_KEYBOARD = 1 << 2
EI_CAP_BUTTON = 1 << 5
EI_CAP_TEXT = 1 << 6
XKB_KEY_DOWN = 1
XKB_KEY_UP = 0
XKB_KEY_SHIFT_L = 0xFFE1
XKB_KEY_SHIFT_R = 0xFFE2


class _Bindings:
    def __init__(self):
        self.ei = ctypes.CDLL(find_library("ei") or "libei.so.1")
        p = ctypes.c_void_p
        u32 = ctypes.c_uint32
        u64 = ctypes.c_uint64
        size = ctypes.c_size_t
        boolean = ctypes.c_bool
        self._fn("ei_new_sender", p, [p])
        self._fn("ei_unref", p, [p])
        self._fn("ei_configure_name", None, [p, ctypes.c_char_p])
        self._fn("ei_setup_backend_fd", ctypes.c_int, [p, ctypes.c_int])
        self._fn("ei_get_fd", ctypes.c_int, [p])
        self._fn("ei_dispatch", None, [p])
        self._fn("ei_get_event", p, [p])
        self._fn("ei_disconnect", None, [p])
        self._fn("ei_now", u64, [p])
        self._fn("ei_event_get_type", ctypes.c_int, [p])
        self._fn("ei_event_get_seat", p, [p])
        self._fn("ei_event_get_device", p, [p])
        self._fn("ei_event_unref", p, [p])
        # Varargs: the fixed first argument is typed. Each call adds a zero sentinel.
        self._fn("ei_seat_bind_capabilities", None, [p])
        self._fn("ei_device_ref", p, [p])
        self._fn("ei_device_unref", p, [p])
        self._fn("ei_device_has_capability", boolean, [p, ctypes.c_int])
        self._fn("ei_device_get_region", p, [p, size])
        self._fn("ei_region_get_x", u32, [p])
        self._fn("ei_region_get_y", u32, [p])
        self._fn("ei_region_get_width", u32, [p])
        self._fn("ei_region_get_height", u32, [p])
        self._fn("ei_region_get_mapping_id", ctypes.c_char_p, [p])
        self._fn("ei_device_keyboard_get_keymap", p, [p])
        self._fn("ei_keymap_get_size", size, [p])
        self._fn("ei_keymap_get_fd", ctypes.c_int, [p])
        self._fn("ei_device_start_emulating", None, [p, u32])
        self._fn("ei_device_stop_emulating", None, [p])
        self._fn("ei_device_frame", None, [p, u64])
        self._fn("ei_device_pointer_motion_absolute", None, [p, ctypes.c_double, ctypes.c_double])
        self._fn("ei_device_button_button", None, [p, u32, boolean])
        self._fn("ei_device_keyboard_key", None, [p, u32, boolean])
        self._fn("ei_device_text_keysym", None, [p, u32, boolean])
        self._fn("ei_device_text_utf8", None, [p, ctypes.c_char_p])

    def _fn(self, name, restype, argtypes):
        fn = getattr(self.ei, name)
        fn.restype = restype
        fn.argtypes = argtypes


class _XkbMapper:
    """Map ASCII and named keysyms through the EIS device keymap."""
    def __init__(self, keymap_text: bytes):
        self.lib = ctypes.CDLL(find_library("xkbcommon") or "libxkbcommon.so.0")
        p = ctypes.c_void_p
        self._fn("xkb_context_new", p, [ctypes.c_int])
        self._fn("xkb_context_unref", None, [p])
        self._fn("xkb_keymap_new_from_string", p, [p, ctypes.c_char_p, ctypes.c_int, ctypes.c_int])
        self._fn("xkb_keymap_unref", None, [p])
        self._fn("xkb_keymap_min_keycode", ctypes.c_uint32, [p])
        self._fn("xkb_keymap_max_keycode", ctypes.c_uint32, [p])
        self._fn("xkb_state_new", p, [p])
        self._fn("xkb_state_unref", None, [p])
        self._fn("xkb_state_key_get_utf8", ctypes.c_int, [p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_size_t])
        self._fn("xkb_state_key_get_one_sym", ctypes.c_uint32, [p, ctypes.c_uint32])
        self._fn("xkb_state_update_key", ctypes.c_int, [p, ctypes.c_uint32, ctypes.c_int])
        self.context = self.lib.xkb_context_new(0)
        self.keymap = self.lib.xkb_keymap_new_from_string(self.context, keymap_text, 1, 0) if self.context else None
        self.state = self.lib.xkb_state_new(self.keymap) if self.keymap else None
        if not self.context or not self.keymap or not self.state:
            self.close()
            raise EiError("could not parse the EIS keyboard keymap")
        self.minimum = int(self.lib.xkb_keymap_min_keycode(self.keymap))
        self.maximum = int(self.lib.xkb_keymap_max_keycode(self.keymap))
        self.shift = self._find_keysym((XKB_KEY_SHIFT_L, XKB_KEY_SHIFT_R))

    def _fn(self, name, restype, argtypes):
        fn = getattr(self.lib, name)
        fn.restype = restype
        fn.argtypes = argtypes

    def _find_keysym(self, wanted: tuple[int, ...]) -> int | None:
        for keycode in range(self.minimum, self.maximum + 1):
            if int(self.lib.xkb_state_key_get_one_sym(self.state, keycode)) in wanted:
                return keycode
        return None

    def _text_for(self, keycode: int) -> str:
        buf = ctypes.create_string_buffer(16)
        length = int(self.lib.xkb_state_key_get_utf8(self.state, keycode, buf, len(buf)))
        return buf.raw[:max(0, length)].decode("utf-8", "strict") if length < len(buf) else ""

    def ascii_key(self, char: str) -> tuple[int, int | None]:
        for keycode in range(self.minimum, self.maximum + 1):
            if self._text_for(keycode) == char:
                return keycode - 8, None
        if self.shift is not None:
            self.lib.xkb_state_update_key(self.state, self.shift, XKB_KEY_DOWN)
            try:
                for keycode in range(self.minimum, self.maximum + 1):
                    if self._text_for(keycode) == char:
                        return keycode - 8, self.shift - 8
            finally:
                self.lib.xkb_state_update_key(self.state, self.shift, XKB_KEY_UP)
        raise EiError(f"character is not available in the EIS keymap: U+{ord(char):04X}")

    def keysym_key(self, keysym: int) -> int:
        keycode = self._find_keysym((keysym,))
        if keycode is None:
            raise EiError(f"keysym is not available in the EIS keymap: 0x{keysym:X}")
        return keycode - 8

    def close(self):
        if getattr(self, "state", None):
            self.lib.xkb_state_unref(self.state)
            self.state = None
        if getattr(self, "keymap", None):
            self.lib.xkb_keymap_unref(self.keymap)
            self.keymap = None
        if getattr(self, "context", None):
            self.lib.xkb_context_unref(self.context)
            self.context = None


class EiSender:
    """Portal EIS sender with one exact ScreenCast region binding."""
    def __init__(self, fd: int, mapping_id: str, timeout_seconds: float = 5.0):
        if not mapping_id:
            os.close(fd)
            raise EiError("selected stream has no mapping ID")
        self.b = _Bindings()
        self.mapping_id = str(mapping_id)
        self.context = self.b.ei.ei_new_sender(None)
        self._lock = threading.RLock()
        self._closed = False
        self._connected = False
        self._disconnected = False
        self._devices: dict[int, dict] = {}
        self._sequence = 0
        self.pointer_id: int | None = None
        self.keyboard_id: int | None = None
        self.text_id: int | None = None
        self.pressed_buttons: set[int] = set()
        self.pressed_keys: set[tuple[int, int]] = set()
        self.mapper: _XkbMapper | None = None
        if not self.context:
            os.close(fd)
            raise EiError("could not create a libei sender")
        self.b.ei.ei_configure_name(self.context, b"Pi Pixel CUA Portal")
        result = int(self.b.ei.ei_setup_backend_fd(self.context, fd))
        if result < 0:
            os.close(fd)
            self.b.ei.ei_unref(self.context)
            self.context = None
            raise EiError(f"could not initialize portal EIS fd: errno {-result}")
        try:
            self._wait_ready(timeout_seconds)
        except Exception:
            self.close()
            raise

    @property
    def inputs_released(self) -> bool:
        return not self.pressed_buttons and not self.pressed_keys

    def metadata(self) -> dict:
        pointer = self._device(self.pointer_id)
        return {
            "pointerRegion": list(pointer["region"]) if pointer and pointer["region"] else None,
            "mappingIdMatched": bool(pointer and pointer["region"]),
            "keyboardKeymapAvailable": self.mapper is not None,
            "textDeviceAvailable": self.text_id is not None,
        }

    def _device(self, device_id: int | None) -> dict | None:
        return self._devices.get(device_id) if device_id is not None else None

    def _usable(self, info: dict | None) -> bool:
        return bool(info and info["resumed"] and info["emulating"])

    def _wait_ready(self, timeout: float):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self._pump(max(0.0, min(0.25, deadline - time.monotonic())))
            if self._connected and self._usable(self._device(self.pointer_id)) and (
                self._usable(self._device(self.text_id)) or self._usable(self._device(self.keyboard_id))
            ):
                return
            if self._disconnected:
                break
        raise EiError("portal EIS did not provide resumed pointer and keyboard devices")

    def _pump(self, timeout: float = 0.0):
        if not self.context or self._disconnected:
            return
        fd = int(self.b.ei.ei_get_fd(self.context))
        if timeout > 0:
            readable, _, _ = select.select([fd], [], [], timeout)
            if not readable:
                return
        self.b.ei.ei_dispatch(self.context)
        while True:
            event = self.b.ei.ei_get_event(self.context)
            if not event:
                break
            try:
                self._handle_event(event)
            finally:
                self.b.ei.ei_event_unref(event)

    def _handle_event(self, event):
        kind = int(self.b.ei.ei_event_get_type(event))
        if kind == EI_EVENT_CONNECT:
            self._connected = True
        elif kind == EI_EVENT_DISCONNECT:
            self._disconnected = True
        elif kind == EI_EVENT_SEAT_ADDED:
            seat = self.b.ei.ei_event_get_seat(event)
            if seat:
                self.b.ei.ei_seat_bind_capabilities(
                    seat,
                    ctypes.c_int(EI_CAP_POINTER_ABSOLUTE),
                    ctypes.c_int(EI_CAP_BUTTON),
                    ctypes.c_int(EI_CAP_KEYBOARD),
                    ctypes.c_int(EI_CAP_TEXT),
                    None,
                )
        elif kind == EI_EVENT_DEVICE_ADDED:
            device = self.b.ei.ei_event_get_device(event)
            if device:
                retained = self.b.ei.ei_device_ref(device)
                device_id = int(retained)
                info = {"ptr": retained, "resumed": False, "emulating": False, "region": None}
                self._devices[device_id] = info
                absolute = bool(self.b.ei.ei_device_has_capability(device, EI_CAP_POINTER_ABSOLUTE))
                button = bool(self.b.ei.ei_device_has_capability(device, EI_CAP_BUTTON))
                if absolute and button:
                    index = 0
                    while True:
                        region = self.b.ei.ei_device_get_region(device, index)
                        if not region:
                            break
                        raw_id = self.b.ei.ei_region_get_mapping_id(region)
                        region_id = raw_id.decode("utf-8", "strict") if raw_id else None
                        if region_id == self.mapping_id:
                            info["region"] = (
                                int(self.b.ei.ei_region_get_x(region)),
                                int(self.b.ei.ei_region_get_y(region)),
                                int(self.b.ei.ei_region_get_width(region)),
                                int(self.b.ei.ei_region_get_height(region)),
                            )
                            self.pointer_id = device_id
                            break
                        index += 1
                if self.b.ei.ei_device_has_capability(device, EI_CAP_TEXT) and self.text_id is None:
                    self.text_id = device_id
                if self.b.ei.ei_device_has_capability(device, EI_CAP_KEYBOARD) and self.keyboard_id is None:
                    self.keyboard_id = device_id
                    self._load_keymap(device)
        elif kind == EI_EVENT_DEVICE_RESUMED:
            self._set_resumed(event, True)
        elif kind == EI_EVENT_DEVICE_PAUSED:
            self._set_resumed(event, False)
        elif kind == EI_EVENT_DEVICE_REMOVED:
            device = self.b.ei.ei_event_get_device(event)
            self._remove_device(int(device)) if device else None

    def _load_keymap(self, device):
        keymap = self.b.ei.ei_device_keyboard_get_keymap(device)
        if not keymap:
            return
        size = int(self.b.ei.ei_keymap_get_size(keymap))
        fd = int(self.b.ei.ei_keymap_get_fd(keymap))
        if size <= 0 or fd < 0:
            return
        with mmap.mmap(fd, size, access=mmap.ACCESS_READ) as mapping:
            text = mapping[:].rstrip(b"\x00") + b"\x00"
        self.mapper = _XkbMapper(text)

    def _set_resumed(self, event, resumed: bool):
        device = self.b.ei.ei_event_get_device(event)
        info = self._devices.get(int(device)) if device else None
        if not info:
            return
        info["resumed"] = resumed
        useful = int(device) in (self.pointer_id, self.text_id, self.keyboard_id)
        if resumed and useful and not info["emulating"]:
            self._sequence = (self._sequence + 1) & 0xFFFFFFFF or 1
            self.b.ei.ei_device_start_emulating(info["ptr"], self._sequence)
            info["emulating"] = True
        elif not resumed:
            info["emulating"] = False
            self.pressed_buttons.clear()
            self.pressed_keys.clear()

    def _remove_device(self, device_id: int):
        info = self._devices.pop(device_id, None)
        if not info:
            return
        if self.pointer_id == device_id:
            self.pointer_id = None
        if self.text_id == device_id:
            self.text_id = None
        if self.keyboard_id == device_id:
            self.keyboard_id = None
            if self.mapper:
                self.mapper.close()
                self.mapper = None
        self.b.ei.ei_device_unref(info["ptr"])

    def _ensure_ready(self, device_id: int | None) -> dict:
        self._pump(0)
        info = self._device(device_id)
        if self._disconnected or not self._usable(info):
            raise EiError("portal EIS device is paused, removed, or disconnected")
        return info

    def _frame(self, info: dict):
        self.b.ei.ei_device_frame(info["ptr"], self.b.ei.ei_now(self.context))

    def move_fraction(self, x_fraction: float, y_fraction: float) -> dict:
        if not (0 <= x_fraction < 1 and 0 <= y_fraction < 1):
            raise EiError("absolute pointer fraction is outside the selected region")
        with self._lock:
            info = self._ensure_ready(self.pointer_id)
            x, y, width, height = info["region"]
            absolute_x = x + x_fraction * width
            absolute_y = y + y_fraction * height
            self.b.ei.ei_device_pointer_motion_absolute(info["ptr"], absolute_x, absolute_y)
            self._frame(info)
            return {
                "eisX": absolute_x,
                "eisY": absolute_y,
                "region": [x, y, width, height],
                "mappingIdMatched": True,
            }

    def click(self, button: int, settle_seconds: float = 0.15, press_seconds: float = 0.05):
        with self._lock:
            info = self._ensure_ready(self.pointer_id)
            time.sleep(settle_seconds)
            self.b.ei.ei_device_button_button(info["ptr"], button, True)
            self.pressed_buttons.add(button)
            self._frame(info)
            try:
                time.sleep(press_seconds)
                self.b.ei.ei_device_button_button(info["ptr"], button, False)
                self._frame(info)
                self.pressed_buttons.discard(button)
            except Exception:
                self.release_inputs()
                raise

    def type_text(self, text: str) -> str:
        with self._lock:
            # The portal granted a keyboard. Prefer its exact EIS keymap so a
            # normal desktop field receives ordinary key events. TEXT is a
            # bounded fallback for EIS implementations without a keymap.
            if self._usable(self._device(self.keyboard_id)) and self.mapper:
                info = self._ensure_ready(self.keyboard_id)
                for char in text:
                    key, shift = self.mapper.ascii_key(char)
                    self._keycode_pair(info, key, shift)
                return "eis-keyboard-keymap"
            if self._usable(self._device(self.text_id)):
                info = self._ensure_ready(self.text_id)
                self.b.ei.ei_device_text_utf8(info["ptr"], text.encode("utf-8"))
                self._frame(info)
                return "eis-text"
            raise EiError("EIS provided no usable keyboard keymap or text device")

    def keysym(self, keysym: int) -> str:
        with self._lock:
            if self._usable(self._device(self.keyboard_id)) and self.mapper:
                info = self._ensure_ready(self.keyboard_id)
                self._keycode_pair(info, self.mapper.keysym_key(keysym), None)
                return "eis-keyboard-keymap"
            if self._usable(self._device(self.text_id)):
                info = self._ensure_ready(self.text_id)
                self.b.ei.ei_device_text_keysym(info["ptr"], keysym, True)
                self.pressed_keys.add((int(info["ptr"]), keysym))
                self._frame(info)
                self.b.ei.ei_device_text_keysym(info["ptr"], keysym, False)
                self._frame(info)
                self.pressed_keys.discard((int(info["ptr"]), keysym))
                return "eis-text"
            raise EiError("EIS provided no usable keyboard keymap or text device")

    def _keycode_pair(self, info: dict, key: int, shift: int | None):
        device_id = int(info["ptr"])
        try:
            if shift is not None:
                self.b.ei.ei_device_keyboard_key(info["ptr"], shift, True)
                self.pressed_keys.add((device_id, shift))
            self.b.ei.ei_device_keyboard_key(info["ptr"], key, True)
            self.pressed_keys.add((device_id, key))
            self._frame(info)
            self.b.ei.ei_device_keyboard_key(info["ptr"], key, False)
            self.pressed_keys.discard((device_id, key))
            if shift is not None:
                self.b.ei.ei_device_keyboard_key(info["ptr"], shift, False)
                self.pressed_keys.discard((device_id, shift))
            self._frame(info)
        except Exception:
            self.release_inputs()
            raise

    def release_inputs(self) -> dict:
        failures: list[str] = []
        with self._lock:
            for device_id, key in list(self.pressed_keys):
                info = self._devices.get(device_id)
                try:
                    if self._usable(info):
                        if device_id == self.text_id:
                            self.b.ei.ei_device_text_keysym(info["ptr"], key, False)
                        else:
                            self.b.ei.ei_device_keyboard_key(info["ptr"], key, False)
                        self._frame(info)
                    self.pressed_keys.discard((device_id, key))
                except Exception as error:
                    failures.append(type(error).__name__)
            info = self._device(self.pointer_id)
            for button in list(self.pressed_buttons):
                try:
                    if self._usable(info):
                        self.b.ei.ei_device_button_button(info["ptr"], button, False)
                        self._frame(info)
                    self.pressed_buttons.discard(button)
                except Exception as error:
                    failures.append(type(error).__name__)
        return {"released": self.inputs_released, "failures": failures}

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self.release_inputs()
            for info in self._devices.values():
                if info["emulating"]:
                    self.b.ei.ei_device_stop_emulating(info["ptr"])
                    info["emulating"] = False
            if self.context:
                self.b.ei.ei_disconnect(self.context)
            for info in list(self._devices.values()):
                self.b.ei.ei_device_unref(info["ptr"])
            self._devices.clear()
            if self.mapper:
                self.mapper.close()
                self.mapper = None
            if self.context:
                self.b.ei.ei_unref(self.context)
                self.context = None
            self.pointer_id = None
            self.keyboard_id = None
            self.text_id = None
