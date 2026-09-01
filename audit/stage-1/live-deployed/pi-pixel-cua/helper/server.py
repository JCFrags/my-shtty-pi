#!/usr/bin/python3
"""JSONL server for the Pixel CUA GNOME portal backend."""
from __future__ import annotations

import json
import os
import queue
import signal
import sys
import threading

from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

from portal_backend import PortalError, PortalRuntime


class Server:
    def __init__(self):
        self.runtime = PortalRuntime()
        self.jobs: queue.Queue[dict | None] = queue.Queue()
        self.output_lock = threading.Lock()
        self.done = threading.Event()
        self.worker = threading.Thread(target=self._work, name="portal-worker", daemon=True)
        self.glib_loop = GLib.MainLoop()
        self.glib_thread = threading.Thread(target=self.glib_loop.run, name="portal-glib", daemon=True)

    def emit(self, envelope: dict) -> None:
        with self.output_lock:
            print(json.dumps(envelope, separators=(",", ":"), sort_keys=True), flush=True)

    def ok(self, request_id: str, result: dict) -> None:
        self.emit({"id": request_id, "ok": True, "result": result})

    def error(self, request_id: str, error: Exception) -> None:
        if isinstance(error, PortalError):
            code, details = error.code, error.details
        else:
            code, details = "BACKEND_ERROR", {}
        self.emit({"id": request_id, "ok": False, "error": {"code": code, "message": str(error), "details": details}})

    def start(self) -> None:
        DBusGMainLoop(set_as_default=True)
        self.glib_thread.start()
        self.worker.start()
        self.ok("ready", {
            "protocol": 1,
            "backend": "portal-wayland",
            "memoryOnlyPixels": True,
            "persistentGrant": False,
            "supportedActions": ["move", "click", "type", "key"],
        })

    def submit(self, request: dict) -> None:
        request_id = str(request.get("id", ""))
        method = request.get("method")
        if not request_id or not isinstance(method, str):
            self.error(request_id or "unknown", PortalError("BAD_REQUEST", "request id and method are required"))
            return
        if method in ("stop", "shutdown"):
            try:
                result = self.runtime.stop()
                self.ok(request_id, result)
            except Exception as error:
                self.error(request_id, error)
            if method == "shutdown":
                self.done.set()
                self.jobs.put(None)
            return
        self.jobs.put(request)

    def _work(self) -> None:
        while not self.done.is_set():
            request = self.jobs.get()
            if request is None:
                return
            request_id = str(request["id"])
            method = str(request["method"])
            params = request.get("params") or {}
            try:
                if method == "start":
                    result = self.runtime.start(int(params.get("consentTimeoutSeconds", 900)))
                elif method == "capture":
                    result = self.runtime.capture(int(params.get("maxDimension", 1024)))
                elif method == "act":
                    result = self.runtime.act(
                        str(params.get("stateId", "")),
                        dict(params.get("action") or {}),
                        int(params.get("maxDimension", 1024)),
                    )
                elif method == "status":
                    result = {
                        "active": self.runtime.started and not self.runtime.stopped.is_set(),
                        "streamIdentity": self.runtime.stream_identity or None,
                        "statesRetained": len(self.runtime.states),
                    }
                else:
                    raise PortalError("BAD_REQUEST", f"unknown method: {method}")
                self.ok(request_id, result)
            except Exception as error:
                self.error(request_id, error)

    def close(self) -> None:
        self.done.set()
        try:
            self.runtime.stop()
        except Exception:
            pass
        self.jobs.put(None)
        self.worker.join(timeout=3)
        self.glib_loop.quit()
        self.glib_thread.join(timeout=2)


def main() -> int:
    if os.environ.get("XDG_SESSION_TYPE") != "wayland":
        print(json.dumps({"id": "startup", "ok": False, "error": {"code": "WRONG_SESSION", "message": "GNOME Wayland session required", "details": {}}}), flush=True)
        return 2
    server = Server()

    def stop_signal(_signum, _frame):
        server.done.set()
        try:
            server.runtime.stop()
        finally:
            raise KeyboardInterrupt

    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)
    server.start()
    try:
        for line in sys.stdin:
            if server.done.is_set():
                break
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("request must be an object")
                server.submit(request)
            except Exception as error:
                server.error("unknown", PortalError("BAD_JSON", str(error)))
        return 0
    except KeyboardInterrupt:
        return 130
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
