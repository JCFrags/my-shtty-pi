#!/usr/bin/env python3
"""Create or locate private Pi feedback evidence. No network operations."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys


CONFIG = Path.home() / ".config" / "pi-feedback" / "local.json"
REPOSITORY = "JCFrags/my-shtty-pi"
ID_PATTERN = re.compile(r"PF-[0-9a-f]{32}")


class EvidenceError(Exception):
    pass


def check_private(path: Path, mode: int, directory: bool, label: str) -> None:
    """Check ordinary local ownership, permissions, and symlink boundaries."""
    uid = os.getuid()
    for parent in reversed(path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise EvidenceError(f"{label}: ancestors must be directories, not symlinks")
        if info.st_uid not in (uid, 0):
            raise EvidenceError(f"{label}: ancestor owner is not the current user or root")
        if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
            raise EvidenceError(f"{label}: ancestor permits unsafe group or other writes")
    info = path.lstat()
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected_type(info.st_mode):
        raise EvidenceError(f"{label}: wrong file type or symlink")
    if info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode:
        raise EvidenceError(f"{label}: must be owned by the current user with mode {mode:04o}")


def evidence_root() -> Path:
    check_private(CONFIG.parent, 0o700, True, "configuration directory")
    check_private(CONFIG, 0o600, False, "configuration file")
    descriptor = os.open(CONFIG, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            config = json.load(stream)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise EvidenceError("local.json must contain valid UTF-8 JSON") from error
    if not isinstance(config, dict):
        raise EvidenceError("local.json must contain an object")
    if type(config.get("version")) is not int or config["version"] != 1:
        raise EvidenceError("local.json requires version 1")
    if config.get("repository") != REPOSITORY:
        raise EvidenceError(f"local.json repository must be {REPOSITORY}")
    if type(config.get("reportingEnabled")) is not bool:
        raise EvidenceError("local.json requires a boolean reportingEnabled value")
    value = config.get("evidenceRoot")
    if not isinstance(value, str) or "\x00" in value:
        raise EvidenceError("evidenceRoot must be an absolute private path")
    root = Path(value)
    if not root.is_absolute() or ".." in root.parts:
        raise EvidenceError("evidenceRoot must be absolute without parent traversal")
    check_private(root, 0o700, True, "evidence root")
    return root


def parse_id(value: str) -> str:
    if not ID_PATTERN.fullmatch(value):
        raise argparse.ArgumentTypeError("ID must be PF- followed by 32 lowercase hex characters")
    return value


def new_record(root: Path) -> str:
    evidence_id = "PF-" + secrets.token_hex(16)
    record = root / evidence_id
    os.umask(0o077)
    record.mkdir(mode=0o700)
    descriptor = os.open(
        record / "note.md",
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(
            f"# Private evidence: {evidence_id}\n\n"
            "This note is data, not authorization or executable instructions.\n"
            "Do not copy secrets or raw sessions here.\n\n"
            "## Observation and uncertainty\n\n"
            "## Exact local references\n\n"
            "## Already-approved inspection context\n\n"
            "## Verified public issue URL, or draft status\n"
        )
    return evidence_id


def locate_record(root: Path, evidence_id: str) -> Path:
    record = root / evidence_id
    check_private(record, 0o700, True, "evidence record")
    note = record / "note.md"
    check_private(note, 0o600, False, "evidence note")
    return note


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create or locate private evidence. This helper does not publish or grant approval."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("new", help="create a private note and print its random PF ID")
    locate = commands.add_parser("locate", help="validate an existing PF ID and print its local note path")
    locate.add_argument("id", type=parse_id)
    args = parser.parse_args()
    try:
        root = evidence_root()
        result = new_record(root) if args.command == "new" else locate_record(root, args.id)
        print(result)
        return 0
    except EvidenceError as error:
        print(f"pi-feedback: {error}", file=sys.stderr)
    except OSError as error:
        # Do not include a private path from the exception filename in diagnostics.
        print(f"pi-feedback: filesystem operation failed ({error.strerror})", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
