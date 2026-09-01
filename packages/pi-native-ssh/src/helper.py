import base64
import json
import os
import stat
import struct
import subprocess
import sys

VERSION = 2
MAX_REQUEST = 12 * 1024 * 1024
MAX_RESPONSE = 48 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_TEXT_SOURCE_BYTES = 128 * 1024 * 1024
MAX_READ_BYTES = 50 * 1024
MAX_READ_LINES = 2_000
MAX_RESULTS = 1000
MAX_SCAN_BYTES = 64 * 1024 * 1024
MAX_CHILD_STDERR = 8 * 1024
MAX_TRANSFER_BYTES = 8 * 1024 * 1024
MAX_EXEC_BYTES = 64 * 1024

class Failure(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__(message)


def strict_loads(data):
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        raise Failure("PROTOCOL_ERROR", "Request JSON is not valid UTF-8")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Failure("PROTOCOL_ERROR", "Request JSON has a duplicate field")
            if len(result) >= 64:
                raise Failure("PROTOCOL_ERROR", "Request JSON object has too many fields")
            result[key] = value
        return result
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except Failure:
        raise
    except Exception:
        raise Failure("PROTOCOL_ERROR", "Request JSON is malformed")


def exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Failure("PROTOCOL_ERROR", label + " fields are invalid")


def bounded_string(value, maximum, label, empty=False):
    if not isinstance(value, str) or (not empty and not value) or len(value) > maximum or "\x00" in value:
        raise Failure("TARGET_INVALID", label + " is invalid")
    return value


def integer(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        raise Failure("TARGET_INVALID", label + " is invalid")
    return value


def resolve_path(cwd, value):
    cwd = bounded_string(cwd, 4096, "cwd")
    value = bounded_string(value, 4096, "path")
    return os.path.normpath(value if os.path.isabs(value) else os.path.join(cwd, value))


def check_source(path, directory=None):
    try:
        info = os.stat(path)
    except FileNotFoundError:
        raise Failure("REMOTE_NOT_FOUND", "Remote path was not found")
    except PermissionError:
        raise Failure("REMOTE_PERMISSION", "Remote permission was denied")
    except OSError:
        raise Failure("REMOTE_COMMAND_FAILED", "Remote path status failed")
    if directory is True and not stat.S_ISDIR(info.st_mode):
        raise Failure("REMOTE_UNSUPPORTED", "Remote path is not a directory")
    if directory is False and stat.S_ISDIR(info.st_mode):
        raise Failure("REMOTE_UNSUPPORTED", "Remote path is a directory")
    return info


def utility(name):
    try:
        result = subprocess.run([name, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=2, check=False)
        if result.returncode != 0 or len(result.stdout) > 512:
            return None
        line = result.stdout.decode("utf-8", "strict").splitlines()[0]
        return line[:200]
    except Exception:
        return None


def capabilities(_args):
    return {
        "protocol": VERSION,
        "python": [sys.version_info.major, sys.version_info.minor],
        "operations": ["read", "ls", "find", "grep", "access", "readRaw", "write", "mkdir", "rollback", "exec"],
        "limits": {
            "requestBytes": MAX_REQUEST,
            "responseBytes": MAX_RESPONSE,
            "readBytes": MAX_READ_BYTES,
            "readLines": MAX_READ_LINES,
            "textSourceBytes": MAX_TEXT_SOURCE_BYTES,
            "results": MAX_RESULTS,
            "scanBytes": MAX_SCAN_BYTES,
            "transferBytes": MAX_TRANSFER_BYTES,
            "execBytes": MAX_EXEC_BYTES,
        },
        "utilities": {"rg": utility("rg"), "fd": utility("fd")},
        "authorization": "remote-account",
    }


def image_mime(header):
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(header) >= 12 and header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    if header.startswith(b"BM"):
        return "image/bmp"
    return None


def read_operation(args):
    exact(args, ["cwd", "path", "offset", "limit"], "Read arguments")
    file_path = resolve_path(args["cwd"], args["path"])
    offset = integer(args["offset"], 1, 2 ** 31 - 1, "offset")
    limit = args["limit"]
    if limit is not None:
        limit = integer(limit, 0, 2 ** 31 - 1, "limit")
    info = check_source(file_path, directory=False)
    try:
        with open(file_path, "rb") as image_stream:
            header = image_stream.read(16)
            mime_type = image_mime(header)
            if mime_type:
                if info.st_size > MAX_IMAGE_BYTES:
                    raise Failure("REMOTE_OUTPUT_LIMIT", "Remote image exceeds the bounded source limit")
                image_stream.seek(0)
                image = image_stream.read(MAX_IMAGE_BYTES + 1)
                if len(image) > MAX_IMAGE_BYTES:
                    raise Failure("REMOTE_OUTPUT_LIMIT", "Remote image exceeds the bounded source limit")
                return {"kind": "image", "mimeType": mime_type, "data": base64.b64encode(image).decode("ascii")}
    except Failure:
        raise
    except PermissionError:
        raise Failure("REMOTE_PERMISSION", "Remote permission was denied")
    except OSError:
        raise Failure("REMOTE_COMMAND_FAILED", "Remote file read failed")
    if info.st_size > MAX_TEXT_SOURCE_BYTES:
        raise Failure("REMOTE_OUTPUT_LIMIT", "Remote text source exceeds the bounded scan limit")
    line_number = 1
    newline_count = 0
    selected_raw = 0
    selected_bytes = 0
    captured = []
    current_length = 0
    current_capture = bytearray()
    current_selected = offset <= line_number and (limit is None or selected_raw < limit)
    ended_with_newline = False
    scanned_bytes = 0

    def finish_line():
        nonlocal line_number, selected_raw, selected_bytes, current_length, current_capture, current_selected
        if current_selected:
            if selected_raw:
                selected_bytes += 1
            selected_bytes += current_length
            selected_raw += 1
            if len(captured) <= MAX_READ_LINES and sum(len(row) for row in captured) <= MAX_READ_BYTES + 1:
                captured.append(bytes(current_capture))
        line_number += 1
        current_length = 0
        current_capture = bytearray()
        current_selected = line_number >= offset and (limit is None or selected_raw < limit)

    try:
        with open(file_path, "rb") as stream:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                scanned_bytes += len(chunk)
                if scanned_bytes > MAX_TEXT_SOURCE_BYTES:
                    raise Failure("REMOTE_OUTPUT_LIMIT", "Remote text source exceeds the bounded scan limit")
                start = 0
                while True:
                    end = chunk.find(b"\n", start)
                    segment = chunk[start:] if end < 0 else chunk[start:end]
                    current_length += len(segment)
                    if current_selected and len(current_capture) <= MAX_READ_BYTES:
                        current_capture.extend(segment[:MAX_READ_BYTES + 1 - len(current_capture)])
                    if end < 0:
                        ended_with_newline = False
                        break
                    newline_count += 1
                    ended_with_newline = True
                    finish_line()
                    start = end + 1
            finish_line()
    except Failure:
        raise
    except PermissionError:
        raise Failure("REMOTE_PERMISSION", "Remote permission was denied")
    except OSError:
        raise Failure("REMOTE_COMMAND_FAILED", "Remote file read failed")

    total_file_lines = newline_count + 1
    if offset > total_file_lines:
        raise Failure("REMOTE_NOT_FOUND", "Read offset is beyond the remote file")
    total_lines = selected_raw
    if selected_bytes == 0:
        total_lines = 0
    elif ended_with_newline and (limit is None or offset - 1 + selected_raw >= total_file_lines):
        total_lines -= 1
    first_large = bool(captured and len(captured[0]) > MAX_READ_BYTES)
    truncated = total_lines > MAX_READ_LINES or selected_bytes > MAX_READ_BYTES
    truncated_by = None
    output_rows = []
    used = 0
    if first_large:
        truncated_by = "bytes"
    else:
        for row in captured[:MAX_READ_LINES]:
            addition = len(row) + (1 if output_rows else 0)
            if used + addition > MAX_READ_BYTES:
                truncated_by = "bytes"
                break
            output_rows.append(row)
            used += addition
        if truncated and truncated_by is None:
            truncated_by = "lines"
    if not truncated:
        output_rows = captured
    data = b"\n".join(output_rows).decode("utf-8", "replace")
    truncation = {
        "truncated": truncated,
        "truncatedBy": truncated_by,
        "totalLines": total_lines,
        "totalBytes": selected_bytes,
        "outputLines": len(output_rows),
        "outputBytes": len(data.encode("utf-8")),
        "lastLinePartial": False,
        "firstLineExceedsLimit": first_large,
        "maxLines": MAX_READ_LINES,
        "maxBytes": MAX_READ_BYTES,
    }
    decoded_data, decoded_truncation = truncate_text(data)
    if decoded_truncation["truncated"]:
        data = decoded_data
        truncation = decoded_truncation
    return {
        "kind": "text",
        "data": data,
        "truncation": truncation,
        "totalFileLines": total_file_lines,
        "startLine": offset,
        "userLimitedLines": None if limit is None else selected_raw,
        "hasMoreAfterUserLimit": limit is not None and offset - 1 + selected_raw < total_file_lines,
    }


def ls_operation(args):
    exact(args, ["cwd", "path", "limit"], "List arguments")
    directory = resolve_path(args["cwd"], args["path"])
    limit = integer(args["limit"], 1, MAX_RESULTS, "limit")
    check_source(directory, directory=True)
    entries = []
    try:
        with os.scandir(directory) as scan:
            for entry in scan:
                if len(entries) >= 10000:
                    raise Failure("REMOTE_OUTPUT_LIMIT", "Remote directory exceeds the scan-entry limit")
                name = bounded_string(entry.name, 4096, "entry name")
                try:
                    is_dir = entry.is_dir(follow_symlinks=True)
                except OSError:
                    continue
                entries.append(name + ("/" if is_dir else ""))
    except PermissionError:
        raise Failure("REMOTE_PERMISSION", "Remote permission was denied")
    except Failure:
        raise
    except OSError:
        raise Failure("REMOTE_COMMAND_FAILED", "Remote directory listing failed")
    entries.sort(key=lambda value: value.lower())
    selected = entries[:limit]
    data, truncation = truncate_text("\n".join(selected), max_lines=2 ** 31 - 1)
    return {"data": data, "empty": len(selected) == 0, "limitReached": len(entries) > limit,
            "truncation": truncation if truncation["truncated"] else None}


def run_lines(argv, line_limit, byte_limit=60 * 1024):
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
    except FileNotFoundError:
        raise Failure("REMOTE_UNSUPPORTED", "Required remote utility is missing")
    except OSError:
        raise Failure("REMOTE_COMMAND_FAILED", "Remote utility could not start")
    lines = []
    used = 0
    limited = False
    try:
        while True:
            raw = process.stdout.readline(byte_limit + 1)
            if not raw:
                break
            if len(raw) > byte_limit or used + len(raw) > byte_limit:
                limited = True
                process.terminate()
                break
            try:
                line = raw.decode("utf-8", "strict").rstrip("\n").rstrip("\r")
            except UnicodeDecodeError:
                process.terminate()
                raise Failure("REMOTE_ENCODING", "Remote utility output is not valid UTF-8")
            lines.append(line)
            used += len(raw)
            if len(lines) >= line_limit:
                limited = True
                process.terminate()
                break
        try:
            _out, stderr = process.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            _out, stderr = process.communicate()
        if len(stderr) > MAX_CHILD_STDERR:
            raise Failure("REMOTE_OUTPUT_LIMIT", "Remote utility diagnostic exceeds its bound")
        diagnostic = stderr.decode("utf-8", "replace")
        if "Permission denied" in diagnostic:
            raise Failure("REMOTE_PERMISSION", "Remote permission was denied")
        if process.returncode not in (0, 1, -15) and not limited:
            raise Failure("REMOTE_COMMAND_FAILED", "Remote utility failed")
        return lines, limited
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def find_operation(args):
    exact(args, ["cwd", "path", "pattern", "limit"], "Find arguments")
    directory = resolve_path(args["cwd"], args["path"])
    pattern = bounded_string(args["pattern"], 1024, "pattern")
    limit = integer(args["limit"], 1, MAX_RESULTS, "limit")
    check_source(directory, directory=True)
    argv = ["fd", "--glob", "--color=never", "--hidden"]
    inside_git = False
    current = directory
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            inside_git = True
            break
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    if not inside_git:
        argv.append("--no-require-git")
    argv += ["--max-results", str(limit + 1)]
    effective = pattern
    if "/" in pattern:
        argv.append("--full-path")
        if not pattern.startswith("/") and not pattern.startswith("**/") and pattern != "**":
            effective = "**/" + pattern
    argv += ["--", effective, directory]
    rows, transport_limited = run_lines(argv, limit + 1)
    relative = []
    for row in rows:
        candidate = os.path.relpath(row, directory) if os.path.isabs(row) else row
        relative.append(candidate.replace(os.sep, "/"))
    selected = relative[:limit]
    data, truncation = truncate_text("\n".join(selected), max_lines=2 ** 31 - 1)
    return {"data": data, "empty": len(selected) == 0,
            "limitReached": transport_limited or len(relative) >= limit,
            "truncation": truncation if truncation["truncated"] else None}


def truncate_text(text, max_lines=MAX_READ_LINES, max_bytes=MAX_READ_BYTES):
    raw_lines = text.split("\n") if text else []
    if text.endswith("\n"):
        raw_lines.pop()
    total_bytes = len(text.encode("utf-8"))
    total_lines = len(raw_lines)
    if total_lines <= max_lines and total_bytes <= max_bytes:
        rows = raw_lines
        truncated = False
        by = None
    elif raw_lines and len(raw_lines[0].encode("utf-8")) > max_bytes:
        rows = []
        truncated = True
        by = "bytes"
    else:
        rows = []
        used = 0
        by = "lines"
        for row in raw_lines[:max_lines]:
            addition = len(row.encode("utf-8")) + (1 if rows else 0)
            if used + addition > max_bytes:
                by = "bytes"
                break
            rows.append(row)
            used += addition
        truncated = True
    content = text if not truncated else "\n".join(rows)
    return content, {
        "truncated": truncated, "truncatedBy": by, "totalLines": total_lines,
        "totalBytes": total_bytes, "outputLines": len(rows),
        "outputBytes": len(content.encode("utf-8")), "lastLinePartial": False,
        "firstLineExceedsLimit": bool(truncated and not rows and raw_lines),
        "maxLines": max_lines, "maxBytes": max_bytes,
    }


def grep_operation(args):
    exact(args, ["cwd", "path", "pattern", "glob", "ignoreCase", "literal", "context", "limit"], "Grep arguments")
    search_path = resolve_path(args["cwd"], args["path"])
    pattern = bounded_string(args["pattern"], 1024, "pattern", empty=True)
    glob = args["glob"]
    if glob is not None:
        glob = bounded_string(glob, 1024, "glob")
    if not isinstance(args["ignoreCase"], bool) or not isinstance(args["literal"], bool):
        raise Failure("TARGET_INVALID", "Grep flags are invalid")
    context = integer(args["context"], 0, 20, "context")
    limit = integer(args["limit"], 1, 100, "limit")
    source_info = check_source(search_path, directory=None)
    is_directory = stat.S_ISDIR(source_info.st_mode)
    argv = ["rg", "--json", "--line-number", "--color=never", "--hidden", "--max-columns", "2048", "--max-columns-preview"]
    if args["ignoreCase"]:
        argv.append("--ignore-case")
    if args["literal"]:
        argv.append("--fixed-strings")
    if glob:
        argv += ["--glob", glob]
    argv += ["--", pattern, search_path]
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
    except FileNotFoundError:
        raise Failure("REMOTE_UNSUPPORTED", "Required remote utility is missing")
    matches = []
    reached = False
    try:
        while True:
            raw = process.stdout.readline(1024 * 1024 + 1)
            if not raw:
                break
            if len(raw) > 1024 * 1024:
                process.terminate()
                raise Failure("REMOTE_OUTPUT_LIMIT", "Remote grep event exceeds its bound")
            try:
                event = json.loads(raw.decode("utf-8", "strict"))
            except Exception:
                process.terminate()
                raise Failure("PROTOCOL_ERROR", "Remote grep event is malformed")
            if event.get("type") != "match":
                continue
            data = event.get("data", {})
            file_path = data.get("path", {}).get("text")
            line_number = data.get("line_number")
            line_text = data.get("lines", {}).get("text")
            if not isinstance(file_path, str) or not isinstance(line_number, int) or not isinstance(line_text, str):
                process.terminate()
                raise Failure("PROTOCOL_ERROR", "Remote grep match fields are invalid")
            matches.append((file_path, line_number, line_text))
            if len(matches) >= limit:
                reached = True
                process.terminate()
                break
        try:
            _unused, diagnostic = process.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            _unused, diagnostic = process.communicate()
        if len(diagnostic) > MAX_CHILD_STDERR:
            raise Failure("REMOTE_OUTPUT_LIMIT", "Remote grep diagnostic exceeds its bound")
        if process.returncode not in (0, 1, -15) and not reached:
            raise Failure("REMOTE_COMMAND_FAILED", "Remote grep failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    if not matches:
        return {"data": "", "truncation": None, "matchLimitReached": False, "linesTruncated": False}
    cache = {}
    scanned = 0
    rows = []
    lines_truncated = False
    for file_path, line_number, line_text in matches:
        relative = os.path.relpath(file_path, search_path).replace(os.sep, "/") if is_directory else os.path.basename(file_path)
        if context == 0:
            line = line_text.replace("\r\n", "\n").replace("\r", "").rstrip("\n")
            if len(line) > 500:
                line = line[:500] + "... [truncated]"
                lines_truncated = True
            rows.append(f"{relative}:{line_number}: {line}")
            continue
        if file_path not in cache:
            try:
                with open(file_path, "rb") as stream:
                    raw_file = stream.read(MAX_SCAN_BYTES + 1)
            except OSError:
                raw_file = b""
            scanned += len(raw_file)
            if scanned > MAX_SCAN_BYTES:
                raise Failure("REMOTE_OUTPUT_LIMIT", "Remote grep context exceeds its scan bound")
            try:
                cache[file_path] = raw_file.decode("utf-8", "strict").replace("\r\n", "\n").replace("\r", "\n").split("\n")
            except UnicodeDecodeError:
                cache[file_path] = []
        lines = cache[file_path]
        if not lines:
            rows.append(f"{relative}:{line_number}: (unable to read file)")
            continue
        first = max(1, line_number - context)
        last = min(len(lines), line_number + context)
        for current in range(first, last + 1):
            line = lines[current - 1]
            if len(line) > 500:
                line = line[:500] + "... [truncated]"
                lines_truncated = True
            separator = ":" if current == line_number else "-"
            rows.append(f"{relative}{separator}{current}{separator} {line}")
    data, truncation = truncate_text("\n".join(rows), max_lines=2 ** 31 - 1)
    return {"data": data, "truncation": truncation if truncation["truncated"] else None,
            "matchLimitReached": reached, "linesTruncated": lines_truncated}


def access_operation(args):
    exact(args, ["cwd", "path", "writable"], "Access arguments")
    path = resolve_path(args["cwd"], args["path"])
    if not isinstance(args["writable"], bool):
        raise Failure("TARGET_INVALID", "Access flag is invalid")
    check_source(path, directory=None)
    mode = os.R_OK | (os.W_OK if args["writable"] else 0)
    if not os.access(path, mode):
        raise Failure("REMOTE_PERMISSION", "Remote access was denied")
    return {"ok": True}


def read_raw_operation(args):
    exact(args, ["cwd", "path", "maxBytes"], "Raw read arguments")
    path = resolve_path(args["cwd"], args["path"])
    maximum = integer(args["maxBytes"], 1, MAX_TRANSFER_BYTES, "maxBytes")
    info = check_source(path, directory=False)
    if info.st_size > maximum:
        raise Failure("REMOTE_OUTPUT_LIMIT", "Remote file exceeds the transfer limit")
    try:
        with open(path, "rb") as stream:
            data = stream.read(maximum + 1)
    except PermissionError:
        raise Failure("REMOTE_PERMISSION", "Remote permission was denied")
    except OSError:
        raise Failure("REMOTE_COMMAND_FAILED", "Remote file read failed")
    if len(data) > maximum:
        raise Failure("REMOTE_OUTPUT_LIMIT", "Remote file exceeds the transfer limit")
    return {"data": base64.b64encode(data).decode("ascii"), "bytes": len(data)}


def backup_paths(path):
    directory, name = os.path.split(path)
    return os.path.join(directory, ".pi-native-ssh-backup-" + name), os.path.join(directory, ".pi-native-ssh-new-" + name)


def write_operation(args):
    exact(args, ["cwd", "path", "data", "maxBytes"], "Write arguments")
    path = resolve_path(args["cwd"], args["path"])
    maximum = integer(args["maxBytes"], 1, MAX_TRANSFER_BYTES, "maxBytes")
    encoded = bounded_string(args["data"], maximum * 2, "data", empty=True)
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception:
        raise Failure("PROTOCOL_ERROR", "Write data is not valid base64")
    if len(data) > maximum:
        raise Failure("REMOTE_OUTPUT_LIMIT", "Write data exceeds the transfer limit")
    directory = os.path.dirname(path)
    check_source(directory, directory=True)
    backup, marker = backup_paths(path)
    temp = os.path.join(directory, ".pi-native-ssh-temp-" + os.path.basename(path) + "-" + os.urandom(6).hex())
    existed = os.path.exists(path)
    try:
        with open(temp, "xb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        if existed:
            if os.path.isdir(path): raise Failure("REMOTE_UNSUPPORTED", "Remote path is a directory")
            os.replace(path, backup)
            try: os.unlink(marker)
            except FileNotFoundError: pass
        else:
            with open(marker, "xb"): pass
            try: os.unlink(backup)
            except FileNotFoundError: pass
        os.replace(temp, path)
    except Failure:
        try: os.unlink(temp)
        except OSError: pass
        raise
    except PermissionError:
        try: os.unlink(temp)
        except OSError: pass
        raise Failure("REMOTE_PERMISSION", "Remote write permission was denied")
    except OSError:
        try: os.unlink(temp)
        except OSError: pass
        raise Failure("REMOTE_COMMAND_FAILED", "Atomic remote write failed")
    return {"bytes": len(data), "rollbackAvailable": True, "created": not existed}


def mkdir_operation(args):
    exact(args, ["cwd", "path"], "Mkdir arguments")
    path = resolve_path(args["cwd"], args["path"])
    try: os.makedirs(path, exist_ok=True)
    except PermissionError: raise Failure("REMOTE_PERMISSION", "Remote mkdir permission was denied")
    except OSError: raise Failure("REMOTE_COMMAND_FAILED", "Remote mkdir failed")
    return {"ok": True}


def rollback_operation(args):
    exact(args, ["cwd", "path"], "Rollback arguments")
    path = resolve_path(args["cwd"], args["path"])
    backup, marker = backup_paths(path)
    try:
        if os.path.exists(backup):
            os.replace(backup, path)
            try: os.unlink(marker)
            except FileNotFoundError: pass
            return {"action": "restored"}
        if os.path.exists(marker):
            if os.path.isdir(path): raise Failure("REMOTE_UNSUPPORTED", "Rollback target is a directory")
            try: os.unlink(path)
            except FileNotFoundError: pass
            os.unlink(marker)
            return {"action": "removed-created-file"}
    except Failure: raise
    except PermissionError: raise Failure("REMOTE_PERMISSION", "Remote rollback permission was denied")
    except OSError: raise Failure("REMOTE_COMMAND_FAILED", "Remote rollback failed")
    raise Failure("REMOTE_NOT_FOUND", "No rollback is available for this path")


def exec_operation(args):
    exact(args, ["cwd", "command", "timeoutMs"], "Exec arguments")
    cwd = bounded_string(args["cwd"], 4096, "cwd")
    command = bounded_string(args["command"], 64 * 1024, "command", empty=True)
    timeout_ms = integer(args["timeoutMs"], 1, 300000, "timeoutMs")
    check_source(cwd, directory=True)
    try:
        process = subprocess.Popen(["/bin/sh", "-c", command], cwd=cwd, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=timeout_ms / 1000)
            timed_out = False
        except subprocess.TimeoutExpired:
            timed_out = True
            try: os.killpg(process.pid, 15)
            except OSError: process.terminate()
            try: stdout, stderr = process.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                try: os.killpg(process.pid, 9)
                except OSError: process.kill()
                stdout, stderr = process.communicate()
    except FileNotFoundError: raise Failure("REMOTE_UNSUPPORTED", "Remote /bin/sh is missing")
    except OSError: raise Failure("REMOTE_COMMAND_FAILED", "Remote command could not start")
    if len(stdout) > MAX_EXEC_BYTES or len(stderr) > MAX_EXEC_BYTES:
        raise Failure("REMOTE_OUTPUT_LIMIT", "Remote command output exceeded its bound")
    return {"stdout": base64.b64encode(stdout).decode("ascii"), "stderr": base64.b64encode(stderr).decode("ascii"),
            "exitCode": process.returncode, "timedOut": timed_out}


OPERATIONS = {"capabilities": capabilities, "read": read_operation, "ls": ls_operation,
              "find": find_operation, "grep": grep_operation, "access": access_operation, "readRaw": read_raw_operation,
              "write": write_operation, "mkdir": mkdir_operation, "rollback": rollback_operation, "exec": exec_operation}


def read_exact(stream, count):
    chunks = []
    remaining = count
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise Failure("PROTOCOL_ERROR", "Request frame is truncated")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def request():
    header = read_exact(sys.stdin.buffer, 4)
    length = struct.unpack(">I", header)[0]
    if length > MAX_REQUEST:
        raise Failure("REMOTE_OUTPUT_LIMIT", "Request frame exceeds its byte limit")
    body = read_exact(sys.stdin.buffer, length)
    trailing = sys.stdin.buffer.read(1)
    if trailing:
        raise Failure("PROTOCOL_ERROR", "Trailing bytes follow the request frame")
    value = strict_loads(body)
    exact(value, ["version", "id", "operation", "args"], "Request")
    if value["version"] != VERSION:
        raise Failure("REMOTE_UNSUPPORTED", "Request protocol version is unsupported")
    request_id = bounded_string(value["id"], 16, "request id")
    if len(request_id) != 16 or any(ch not in "0123456789abcdef" for ch in request_id):
        raise Failure("PROTOCOL_ERROR", "Request id is invalid")
    operation = value["operation"]
    if operation not in OPERATIONS:
        raise Failure("REMOTE_UNSUPPORTED", "Requested operation is unsupported")
    if not isinstance(value["args"], dict):
        raise Failure("PROTOCOL_ERROR", "Request arguments are invalid")
    return request_id, operation, value["args"]


def send(value):
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(body) > MAX_RESPONSE:
        body = json.dumps({"version": VERSION, "id": value.get("id", "0" * 16), "ok": False,
                           "error": {"code": "REMOTE_OUTPUT_LIMIT", "message": "Response exceeds its byte limit"}},
                          separators=(",", ":"), sort_keys=True).encode("utf-8")
    sys.stdout.buffer.write(struct.pack(">I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def main():
    request_id = "0" * 16
    try:
        request_id, operation, args = request()
        result = OPERATIONS[operation](args)
        send({"version": VERSION, "id": request_id, "ok": True, "result": result})
    except Failure as error:
        send({"version": VERSION, "id": request_id, "ok": False,
              "error": {"code": error.code, "message": error.message[:300]}})
    except Exception:
        send({"version": VERSION, "id": request_id, "ok": False,
              "error": {"code": "UNKNOWN", "message": "Remote helper failed safely"}})

main()
