#!/usr/bin/env python3
"""In-memory supervisor for one persistent non-PTY Native SSH session."""

import base64
import hashlib
import json
import os
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys

VERSION = 1
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_COMMAND_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 48 * 1024 * 1024
MAX_RESOURCE_FILE_BYTES = 2 * 1024 * 1024
MAX_RESOURCE_SEARCH_BYTES = 2 * 1024 * 1024
MAX_RESOURCE_HITS = 20000
FENCE_PREFIX = b"\x1e"
FENCE_SUFFIX = b"\x1f"


class ProtocolFailure(Exception):
    pass


class ResourceFailure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ProtocolFailure(f"duplicate field: {key}")
        value[key] = item
    return value


def exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ProtocolFailure(f"{label} fields are invalid")


def decode_json(body):
    try:
        text = body.decode("utf-8", "strict")
        return json.loads(text, object_pairs_hook=strict_object)
    except ProtocolFailure:
        raise
    except Exception as error:
        raise ProtocolFailure("frame JSON is invalid") from error


def canonical_base64(value, maximum, label):
    if not isinstance(value, str):
        raise ProtocolFailure(f"{label} is invalid")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except Exception as error:
        raise ProtocolFailure(f"{label} is invalid") from error
    if len(raw) > maximum or base64.b64encode(raw).decode("ascii") != value:
        raise ProtocolFailure(f"{label} is invalid")
    return raw


def write_frame(value):
    body = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise ProtocolFailure("outbound frame exceeds its limit")
    sys.stdout.buffer.write(struct.pack(">I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def read_initial_frame():
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        raise ProtocolFailure("open frame header is incomplete")
    length = struct.unpack(">I", header)[0]
    if length > MAX_FRAME_BYTES:
        raise ProtocolFailure("open frame exceeds its limit")
    body = sys.stdin.buffer.read(length)
    if len(body) != length:
        raise ProtocolFailure("open frame is incomplete")
    return decode_json(body)


class Decoder:
    def __init__(self):
        self.buffer = bytearray()

    def push(self, data):
        self.buffer.extend(data)
        frames = []
        while len(self.buffer) >= 4:
            length = struct.unpack(">I", self.buffer[:4])[0]
            if length > MAX_FRAME_BYTES:
                raise ProtocolFailure("frame exceeds its limit")
            if len(self.buffer) < length + 4:
                break
            body = bytes(self.buffer[4 : length + 4])
            del self.buffer[: length + 4]
            frames.append(decode_json(body))
        return frames

    def finish(self):
        if self.buffer:
            raise ProtocolFailure("truncated frame")


class FenceStream:
    def __init__(self, fence):
        self.marker = FENCE_PREFIX + fence.encode("ascii") + FENCE_SUFFIX
        self.buffer = bytearray()
        self.done = False

    def push(self, data):
        if self.done:
            if data:
                raise ProtocolFailure("bytes followed a stream fence")
            return []
        self.buffer.extend(data)
        index = self.buffer.find(self.marker)
        if index >= 0:
            before = bytes(self.buffer[:index])
            after = bytes(self.buffer[index + len(self.marker) :])
            self.buffer.clear()
            self.done = True
            if after:
                raise ProtocolFailure("bytes followed a stream fence")
            return [before] if before else []
        safe = max(0, len(self.buffer) - len(self.marker) + 1)
        if safe == 0:
            return []
        value = bytes(self.buffer[:safe])
        del self.buffer[:safe]
        return [value]


def resource_string(value, maximum, label, empty=False):
    if not isinstance(value, str) or (not empty and not value) or "\x00" in value or len(value.encode("utf-8")) > maximum:
        raise ResourceFailure("SESSION_RESOURCE_ARGUMENT_INVALID", f"{label} is invalid")
    return value


def resource_integer(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        raise ResourceFailure("SESSION_RESOURCE_ARGUMENT_INVALID", f"{label} is invalid")
    return value


def resource_path(cwd, value):
    value = resource_string(value, 4096, "path")
    absolute = value if os.path.isabs(value) else os.path.join(cwd, value)
    return os.path.realpath(os.path.normpath(absolute))


def resource_stat(path, allow_missing=False):
    try:
        info = os.stat(path)
    except FileNotFoundError:
        if allow_missing:
            return None
        raise ResourceFailure("REMOTE_NOT_FOUND", "Remote path was not found")
    except PermissionError:
        raise ResourceFailure("REMOTE_PERMISSION", "Remote permission was denied")
    except OSError:
        raise ResourceFailure("REMOTE_COMMAND_FAILED", "Remote path status failed")
    if not stat.S_ISREG(info.st_mode):
        raise ResourceFailure("REMOTE_UNSUPPORTED", "Remote path is not a regular file")
    return info


def resource_read(cwd, args):
    exact(args, ["path", "allowMissing", "maxBytes"], "resource read")
    if not isinstance(args["allowMissing"], bool):
        raise ResourceFailure("SESSION_RESOURCE_ARGUMENT_INVALID", "allowMissing is invalid")
    maximum = resource_integer(args["maxBytes"], 1, MAX_RESOURCE_FILE_BYTES, "maxBytes")
    path = resource_path(cwd, args["path"])
    info = resource_stat(path, args["allowMissing"])
    if info is None:
        return {"canonicalPath": path, "exists": False}
    if info.st_size > maximum:
        raise ResourceFailure("SESSION_RESOURCE_LIMIT", "Remote file exceeds the session resource byte limit")
    try:
        with open(path, "rb") as stream:
            data = stream.read(maximum + 1)
    except PermissionError:
        raise ResourceFailure("REMOTE_PERMISSION", "Remote file read permission was denied")
    except OSError:
        raise ResourceFailure("REMOTE_COMMAND_FAILED", "Remote file read failed")
    if len(data) > maximum:
        raise ResourceFailure("SESSION_RESOURCE_LIMIT", "Remote file exceeds the session resource byte limit")
    return {
        "canonicalPath": path,
        "exists": True,
        "dataBase64": base64.b64encode(data).decode("ascii"),
        "bytes": len(data),
        "rawDigest": hashlib.sha256(data).hexdigest(),
        "mode": stat.S_IMODE(info.st_mode),
        "hardLinks": info.st_nlink,
    }


def rollback_paths(path):
    directory, name = os.path.split(path)
    return os.path.join(directory, ".pi-native-ssh-backup-" + name), os.path.join(directory, ".pi-native-ssh-new-" + name)


def fsync_directory(directory):
    try:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        pass


def resource_commit(cwd, args):
    exact(args, ["path", "canonicalPath", "dataBase64", "expectedExists", "expectedRawDigest", "maxBytes"], "resource commit")
    maximum = resource_integer(args["maxBytes"], 1, MAX_RESOURCE_FILE_BYTES, "maxBytes")
    requested = resource_path(cwd, args["path"])
    canonical = resource_string(args["canonicalPath"], 4096, "canonicalPath")
    if not os.path.isabs(canonical) or requested != canonical:
        raise ResourceFailure("SESSION_FILE_CONFLICT", "Remote path identity changed before commit")
    if not isinstance(args["expectedExists"], bool):
        raise ResourceFailure("SESSION_RESOURCE_ARGUMENT_INVALID", "expectedExists is invalid")
    expected_digest = args["expectedRawDigest"]
    if expected_digest is not None and (not isinstance(expected_digest, str) or len(expected_digest) != 64 or any(ch not in "0123456789abcdef" for ch in expected_digest)):
        raise ResourceFailure("SESSION_RESOURCE_ARGUMENT_INVALID", "expectedRawDigest is invalid")
    try:
        data = base64.b64decode(resource_string(args["dataBase64"], maximum * 2, "dataBase64", empty=True).encode("ascii"), validate=True)
    except Exception as error:
        if isinstance(error, ResourceFailure):
            raise
        raise ResourceFailure("SESSION_RESOURCE_ARGUMENT_INVALID", "dataBase64 is invalid") from error
    if len(data) > maximum or base64.b64encode(data).decode("ascii") != args["dataBase64"]:
        raise ResourceFailure("SESSION_RESOURCE_ARGUMENT_INVALID", "Remote commit data is invalid or too large")

    current = resource_stat(canonical, allow_missing=True)
    if args["expectedExists"] != (current is not None):
        raise ResourceFailure("SESSION_FILE_CONFLICT", "Remote file existence changed before commit")
    if current is not None:
        try:
            with open(canonical, "rb") as stream:
                current_data = stream.read(maximum + 1)
        except PermissionError:
            raise ResourceFailure("REMOTE_PERMISSION", "Remote file read permission was denied")
        except OSError:
            raise ResourceFailure("REMOTE_COMMAND_FAILED", "Remote file read failed")
        if len(current_data) > maximum:
            raise ResourceFailure("SESSION_RESOURCE_LIMIT", "Remote file exceeds the session resource byte limit")
        if expected_digest is None or hashlib.sha256(current_data).hexdigest() != expected_digest:
            raise ResourceFailure("SESSION_FILE_CONFLICT", "Remote file changed before commit")
    elif expected_digest is not None:
        raise ResourceFailure("SESSION_FILE_CONFLICT", "Remote file digest cannot match a missing file")

    directory = os.path.dirname(canonical)
    try:
        directory_info = os.stat(directory)
        if not stat.S_ISDIR(directory_info.st_mode):
            raise ResourceFailure("REMOTE_UNSUPPORTED", "Remote parent path is not a directory")
    except FileNotFoundError:
        raise ResourceFailure("REMOTE_NOT_FOUND", "Remote parent directory was not found")
    except PermissionError:
        raise ResourceFailure("REMOTE_PERMISSION", "Remote parent permission was denied")
    except ResourceFailure:
        raise
    except OSError:
        raise ResourceFailure("REMOTE_COMMAND_FAILED", "Remote parent status failed")

    token = os.urandom(8).hex()
    temp = os.path.join(directory, "." + os.path.basename(canonical) + ".pi-grounded-tmp-" + token)
    backup, marker = rollback_paths(canonical)
    backup_temp = backup + ".tmp-" + token
    marker_temp = marker + ".tmp-" + token
    existed = current is not None
    try:
        mode = stat.S_IMODE(current.st_mode) if current is not None else 0o600
        with open(temp, "xb") as stream:
            os.chmod(temp, mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if current is not None:
            try:
                os.chown(temp, current.st_uid, current.st_gid)
            except (PermissionError, AttributeError, OSError):
                pass
            shutil.copy2(canonical, backup_temp)
            with open(backup_temp, "rb") as backup_stream:
                os.fsync(backup_stream.fileno())
            os.replace(backup_temp, backup)
            try:
                os.unlink(marker)
            except FileNotFoundError:
                pass
        else:
            with open(marker_temp, "xb") as marker_stream:
                marker_stream.flush()
                os.fsync(marker_stream.fileno())
            os.replace(marker_temp, marker)
            try:
                os.unlink(backup)
            except FileNotFoundError:
                pass
        os.replace(temp, canonical)
        fsync_directory(directory)
    except ResourceFailure:
        raise
    except PermissionError:
        raise ResourceFailure("REMOTE_PERMISSION", "Remote commit permission was denied")
    except OSError:
        raise ResourceFailure("REMOTE_COMMAND_FAILED", "Atomic remote commit failed")
    finally:
        for leftover in (temp, backup_temp, marker_temp):
            try:
                os.unlink(leftover)
            except OSError:
                pass
    return {
        "canonicalPath": canonical,
        "bytes": len(data),
        "rawDigest": hashlib.sha256(data).hexdigest(),
        "created": not existed,
        "atomic": True,
        "preservedHardLinks": False,
        "hardLinksBefore": current.st_nlink if current is not None else 0,
        "rollbackAvailable": True,
    }


def run_search(argv, cwd, label):
    try:
        process = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    except FileNotFoundError:
        raise ResourceFailure("REMOTE_UNSUPPORTED", f"Required remote {label} utility is missing")
    except subprocess.TimeoutExpired:
        raise ResourceFailure("REMOTE_TIMEOUT", f"Remote {label} search timed out")
    except OSError:
        raise ResourceFailure("REMOTE_COMMAND_FAILED", f"Remote {label} search failed")
    if len(process.stdout) > MAX_RESOURCE_SEARCH_BYTES or len(process.stderr) > 8192:
        raise ResourceFailure("SESSION_RESOURCE_LIMIT", f"Remote {label} search output exceeds its limit")
    if process.returncode not in (0, 1):
        message = process.stderr.decode("utf-8", "replace").strip()[:300]
        raise ResourceFailure("REMOTE_COMMAND_FAILED", f"Remote {label} search failed" + (f": {message}" if message else ""))
    return process.stdout


def decode_rg_data(value):
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("text"), str):
        return value["text"]
    if isinstance(value.get("bytes"), str):
        try:
            return base64.b64decode(value["bytes"], validate=True).decode("utf-8", "replace")
        except Exception as error:
            raise ResourceFailure("REMOTE_COMMAND_FAILED", "ripgrep returned invalid path or line data") from error
    return ""


def reported_path(cwd, value):
    path = os.path.relpath(value, cwd) if os.path.isabs(value) else value
    return path[2:] if path.startswith("./") else path


def append_resource_ignore_files(argv, cwd, scope):
    candidates = {os.path.join(cwd, ".gitignore"), os.path.join(resource_path(cwd, scope), ".gitignore")}
    for candidate in sorted(candidates):
        if os.path.isfile(candidate):
            argv.extend(["--ignore-file", candidate])


def resource_search_text(cwd, args):
    exact(args, ["query", "path", "fileGlob", "ignoreCase", "literal", "contextLines"], "resource text search")
    query = resource_string(args["query"], 64 * 1024, "query")
    scope = resource_string(args["path"], 4096, "path")
    file_glob = args["fileGlob"]
    if file_glob is not None:
        file_glob = resource_string(file_glob, 4096, "fileGlob")
    if not isinstance(args["ignoreCase"], bool) or not isinstance(args["literal"], bool):
        raise ResourceFailure("SESSION_RESOURCE_ARGUMENT_INVALID", "Remote text search flags are invalid")
    context = resource_integer(args["contextLines"], 0, 20, "contextLines")
    argv = ["rg", "--json", "--no-config", "--line-number", "--column", "--sort", "path", "--hidden", "--no-require-git", "--glob", "!**/.git/**"]
    if args["ignoreCase"]:
        argv.append("--ignore-case")
    if args["literal"]:
        argv.append("--fixed-strings")
    if file_glob is not None:
        argv.extend(["--glob", file_glob])
    if context:
        argv.extend(["--context", str(context)])
    append_resource_ignore_files(argv, cwd, scope)
    argv.extend(["--", query, scope])
    output = run_search(argv, cwd, "text")
    records = {}
    matches = []
    try:
        lines = output.decode("utf-8", "strict").splitlines()
        for raw in lines:
            event = json.loads(raw)
            if not isinstance(event, dict) or event.get("type") not in ("match", "context"):
                continue
            data = event.get("data")
            if not isinstance(data, dict):
                continue
            path = reported_path(cwd, decode_rg_data(data.get("path")))
            line = data.get("line_number")
            if not path or isinstance(line, bool) or not isinstance(line, int) or line < 1:
                continue
            text = decode_rg_data(data.get("lines")).rstrip("\r\n")
            records.setdefault(path, {})[line] = text
            if event["type"] == "match":
                submatches = data.get("submatches")
                if not isinstance(submatches, list) or not submatches:
                    raise ResourceFailure("REMOTE_COMMAND_FAILED", "ripgrep returned an invalid match")
                start = submatches[0].get("start")
                if isinstance(start, bool) or not isinstance(start, int) or start < 0:
                    raise ResourceFailure("REMOTE_COMMAND_FAILED", "ripgrep returned an invalid match")
                matches.append((path, line, start + 1, text, len(submatches)))
                if len(matches) > MAX_RESOURCE_HITS:
                    raise ResourceFailure("SESSION_RESOURCE_LIMIT", "Remote text search returned too many hits")
    except ResourceFailure:
        raise
    except Exception as error:
        raise ResourceFailure("REMOTE_COMMAND_FAILED", "ripgrep returned invalid JSON output") from error
    hits = []
    for path, line, column, text, count in matches:
        available = sorted(number for number in records.get(path, {}) if abs(number - line) <= context)
        start_line = available[0] if available else line
        end_line = available[-1] if available else line
        snippet = "\n".join(f"{number}: {records[path].get(number, '')}" for number in available)
        hits.append({"path": path, "line": line, "byteColumn": column, "text": text, "snippet": snippet,
                     "snippetStartLine": start_line, "snippetEndLine": end_line, "submatchCount": count})
    hits.sort(key=lambda item: (item["path"], item["line"], item["byteColumn"]))
    return {"hits": hits}


def resource_search_files(cwd, args):
    exact(args, ["path"], "resource file search")
    scope = resource_string(args["path"], 4096, "path")
    argv = ["fd", "--print0", "--color=never", "--type", "f", "--type", "d", "--hidden", "--no-require-git", "--exclude", ".git"]
    append_resource_ignore_files(argv, cwd, scope)
    argv.extend([".", scope])
    output = run_search(argv, cwd, "file")
    try:
        values = [value for value in output.decode("utf-8", "strict").split("\x00") if value]
    except UnicodeDecodeError as error:
        raise ResourceFailure("REMOTE_COMMAND_FAILED", "fd returned invalid UTF-8 output") from error
    if len(values) > MAX_RESOURCE_HITS:
        raise ResourceFailure("SESSION_RESOURCE_LIMIT", "Remote file search returned too many paths")
    hits = []
    for value in values:
        path = reported_path(cwd, value)
        absolute = value if os.path.isabs(value) else os.path.join(cwd, value)
        hits.append({"path": path, "kind": "directory" if os.path.isdir(absolute) else "file"})
    hits.sort(key=lambda item: item["path"])
    return {"hits": hits}


RESOURCE_OPERATIONS = {
    "resolve": lambda cwd, args: {"canonicalPath": resource_path(cwd, args["path"])} if isinstance(args, dict) and set(args) == {"path"} else (_ for _ in ()).throw(ProtocolFailure("resource resolve fields are invalid")),
    "read": resource_read,
    "commit": resource_commit,
    "searchText": resource_search_text,
    "searchFiles": resource_search_files,
}


class Supervisor:
    def __init__(self, generation, cwd):
        control_read, control_write = os.pipe()
        os.set_inheritable(control_write, True)
        env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "PI_SESSION_CONTROL_FD": str(control_write)}
        self.shell = subprocess.Popen(
            ["/bin/bash", "--noprofile", "--norc"],
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(control_write,),
            start_new_session=True,
            bufsize=0,
        )
        os.close(control_write)
        self.control = os.fdopen(control_read, "rb", buffering=0)
        self.generation = generation
        self.cwd = cwd
        self.expected_sequence = 1
        self.expected_resource_sequence = 1
        self.active = None
        self.total_output = 0
        self.input_decoder = Decoder()
        self.control_buffer = bytearray()
        self.selector = selectors.DefaultSelector()
        for stream, label in ((sys.stdin.buffer, "input"), (self.shell.stdout, "stdout"), (self.shell.stderr, "stderr"), (self.control, "control")):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, label)

    def frame_base(self, frame, keys, label):
        exact(frame, keys, label)
        if frame["version"] != VERSION or frame["generation"] != self.generation:
            raise ProtocolFailure(f"{label} version or generation mismatch")

    def start(self, frame):
        self.frame_base(frame, ["version", "type", "generation", "requestId", "sequence", "commandBase64"], "execute")
        if frame["type"] != "execute" or self.active is not None:
            raise ProtocolFailure("execute frame is not valid while the session is busy")
        request_id = frame["requestId"]
        sequence = frame["sequence"]
        if not isinstance(request_id, str) or len(request_id) != 32 or any(ch not in "0123456789abcdef" for ch in request_id):
            raise ProtocolFailure("execute request id is invalid")
        if sequence != self.expected_sequence:
            raise ProtocolFailure("execute sequence mismatch")
        command = canonical_base64(frame["commandBase64"], MAX_COMMAND_BYTES, "command")
        if b"\x00" in command:
            raise ProtocolFailure("command contains a NUL byte")
        fence = os.urandom(32).hex()
        encoded = base64.b64encode(command).decode("ascii")
        marker = "\\036" + fence + "\\037"
        python_control = (
            'import json,os,sys;'
            'value=dict(version=1,requestId=sys.argv[2],generation=int(sys.argv[3]),'
            'action="complete",sequence=int(sys.argv[4]),cwd=sys.argv[5],'
            'exitCode=int(sys.argv[6]),signal=None,fence=sys.argv[7]);'
            'body=json.dumps(value,separators=(",",":")).encode();'
            'os.write(int(sys.argv[1]),len(body).to_bytes(4,"big")+body)'
        )
        wrapper = "\n".join(
            [
                "__pi_command=$(python3 -c 'import base64,sys;sys.stdout.buffer.write(base64.b64decode(sys.argv[1],validate=True))' '" + encoded + "')",
                "trap ':' INT",
                'eval "$__pi_command"',
                "__pi_status=$?",
                "trap - INT",
                "__pi_cwd=$PWD",
                "printf '" + marker + "' >&1",
                "printf '" + marker + "' >&2",
                "python3 -c '" + python_control + "' \"$PI_SESSION_CONTROL_FD\" '" + request_id + "' '" + str(self.generation) + "' '" + str(sequence) + "' \"$__pi_cwd\" \"$__pi_status\" '" + fence + "'",
                "unset __pi_command __pi_status __pi_cwd",
                "",
            ]
        ).encode("utf-8")
        self.active = {
            "requestId": request_id,
            "sequence": sequence,
            "fence": fence,
            "stdout": FenceStream(fence),
            "stderr": FenceStream(fence),
            "control": None,
            "outputSequence": 0,
        }
        self.expected_sequence += 1
        self.shell.stdin.write(wrapper)
        self.shell.stdin.flush()

    def cancel(self, frame):
        self.frame_base(frame, ["version", "type", "generation", "requestId", "sequence"], "cancel")
        active = self.active
        if frame["type"] != "cancel" or active is None or frame["requestId"] != active["requestId"] or frame["sequence"] != active["sequence"]:
            raise ProtocolFailure("cancel frame does not match the active command")
        try:
            os.killpg(self.shell.pid, signal.SIGINT)
        except ProcessLookupError:
            pass

    def output(self, stream, data):
        active = self.active
        if active is None:
            if data:
                raise ProtocolFailure(f"unexpected {stream} bytes while idle")
            return
        for chunk in active[stream].push(data):
            if not chunk:
                continue
            self.total_output += len(chunk)
            if self.total_output > MAX_OUTPUT_BYTES:
                raise ProtocolFailure("session output exceeds its limit")
            sequence = active["outputSequence"]
            active["outputSequence"] += 1
            write_frame(
                {
                    "version": VERSION,
                    "type": "output",
                    "generation": self.generation,
                    "requestId": active["requestId"],
                    "commandSequence": active["sequence"],
                    "sequence": sequence,
                    "stream": stream,
                    "dataBase64": base64.b64encode(chunk).decode("ascii"),
                    "bytes": len(chunk),
                }
            )
        self.maybe_complete()

    def control_data(self, data):
        self.control_buffer.extend(data)
        while len(self.control_buffer) >= 4:
            length = struct.unpack(">I", self.control_buffer[:4])[0]
            if length > MAX_FRAME_BYTES:
                raise ProtocolFailure("control frame exceeds its limit")
            if len(self.control_buffer) < length + 4:
                break
            frame = decode_json(bytes(self.control_buffer[4 : length + 4]))
            del self.control_buffer[: length + 4]
            active = self.active
            if active is None:
                raise ProtocolFailure("completion arrived while idle")
            exact(frame, ["version", "requestId", "generation", "action", "sequence", "cwd", "exitCode", "signal", "fence"], "completion")
            if (
                frame["version"] != VERSION
                or frame["generation"] != self.generation
                or frame["action"] != "complete"
                or frame["requestId"] != active["requestId"]
                or frame["sequence"] != active["sequence"]
                or frame["fence"] != active["fence"]
                or frame["signal"] is not None
                or not isinstance(frame["cwd"], str)
                or not frame["cwd"].startswith("/")
                or not isinstance(frame["exitCode"], int)
                or not -255 <= frame["exitCode"] <= 255
            ):
                raise ProtocolFailure("completion frame does not match the active command")
            active["control"] = frame
            self.maybe_complete()

    def maybe_complete(self):
        active = self.active
        if active is None or active["control"] is None or not active["stdout"].done or not active["stderr"].done:
            return
        frame = active["control"]
        self.cwd = frame["cwd"]
        write_frame(
            {
                "version": VERSION,
                "type": "complete",
                "generation": self.generation,
                "requestId": active["requestId"],
                "sequence": active["sequence"],
                "cwd": self.cwd,
                "exitCode": frame["exitCode"],
                "signal": None,
            }
        )
        self.active = None
        self.total_output = 0

    def resource(self, frame):
        self.frame_base(frame, ["version", "type", "generation", "requestId", "sequence", "operation", "cwd", "args"], "resource")
        if frame["type"] != "resource" or self.active is not None:
            raise ProtocolFailure("resource frame is invalid while the session is busy")
        request_id = frame["requestId"]
        sequence = frame["sequence"]
        operation = frame["operation"]
        if not isinstance(request_id, str) or len(request_id) != 32 or any(ch not in "0123456789abcdef" for ch in request_id):
            raise ProtocolFailure("resource request id is invalid")
        if sequence != self.expected_resource_sequence:
            raise ProtocolFailure("resource sequence mismatch")
        if frame["cwd"] != self.cwd:
            raise ResourceFailure("SESSION_FILE_CONFLICT", "Session working directory changed before the file operation")
        if not isinstance(operation, str) or operation not in RESOURCE_OPERATIONS:
            raise ProtocolFailure("resource operation is unsupported")
        self.expected_resource_sequence += 1
        try:
            result = RESOURCE_OPERATIONS[operation](self.cwd, frame["args"])
        except ResourceFailure as error:
            write_frame({"version": VERSION, "type": "resourceError", "generation": self.generation,
                         "requestId": request_id, "sequence": sequence, "code": error.code, "message": error.message[:300]})
            return
        write_frame({"version": VERSION, "type": "resourceResult", "generation": self.generation,
                     "requestId": request_id, "sequence": sequence, "result": result})

    def handle_input(self, frame):
        if not isinstance(frame, dict) or frame.get("type") not in ("execute", "cancel", "resource", "close"):
            raise ProtocolFailure("input frame type is invalid")
        if frame["type"] == "execute":
            self.start(frame)
        elif frame["type"] == "cancel":
            self.cancel(frame)
        elif frame["type"] == "resource":
            self.resource(frame)
        else:
            self.frame_base(frame, ["version", "type", "generation"], "close")
            if self.active is not None:
                raise ProtocolFailure("close arrived while a command is active")
            return False
        return True

    def run(self):
        write_frame({"version": VERSION, "type": "ready", "generation": self.generation, "sequence": 0, "cwd": self.cwd})
        running = True
        while running:
            if self.shell.poll() is not None:
                raise ProtocolFailure("persistent shell exited")
            events = self.selector.select(0.25)
            for key, _mask in events:
                label = key.data
                data = os.read(key.fileobj.fileno(), 64 * 1024)
                if not data:
                    if label == "input":
                        self.input_decoder.finish()
                        return
                    raise ProtocolFailure(f"{label} channel closed")
                if label == "input":
                    for frame in self.input_decoder.push(data):
                        running = self.handle_input(frame)
                        if not running:
                            break
                elif label == "control":
                    self.control_data(data)
                else:
                    self.output(label, data)

    def close(self):
        try:
            os.killpg(self.shell.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.shell.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.shell.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.shell.wait(timeout=1)


def main():
    supervisor = None
    try:
        frame = read_initial_frame()
        exact(frame, ["version", "type", "generation", "cwd"], "open")
        if frame["version"] != VERSION or frame["type"] != "open" or not isinstance(frame["generation"], int) or frame["generation"] < 1:
            raise ProtocolFailure("open frame version or generation is invalid")
        cwd = frame["cwd"]
        if not isinstance(cwd, str) or not cwd.startswith("/") or len(cwd.encode("utf-8")) > 4096 or "\x00" in cwd or not os.path.isdir(cwd):
            raise ProtocolFailure("open cwd is invalid")
        supervisor = Supervisor(frame["generation"], cwd)
        supervisor.run()
    except ProtocolFailure as error:
        try:
            write_frame({"version": VERSION, "type": "error", "code": "SESSION_PROTOCOL_ERROR", "message": str(error)[:300]})
        except Exception:
            pass
    except Exception:
        try:
            write_frame({"version": VERSION, "type": "error", "code": "SESSION_REMOTE_FAILED", "message": "remote session supervisor failed"})
        except Exception:
            pass
    finally:
        if supervisor is not None:
            supervisor.close()


if __name__ == "__main__":
    main()
