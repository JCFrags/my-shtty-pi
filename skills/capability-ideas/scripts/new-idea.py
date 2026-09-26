#!/usr/bin/env python3
"""Create one private idea from the bundled template. No network operations."""

from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
import stat
import sys


ROOT = Path.home() / ".local" / "state" / "pi-capability-ideas" / "ideas"
TEMPLATE = Path(__file__).resolve().parents[1] / "templates" / "idea.md"


def check_store() -> None:
    uid = os.getuid()
    for path in (*reversed(ROOT.parents), ROOT):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("store paths must be directories, not symlinks")
        if info.st_uid not in (uid, 0):
            raise ValueError("store ancestors must belong to the current user or root")
        if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
            raise ValueError("store ancestors permit unsafe group or other writes")
        if path in (ROOT.parent, ROOT):
            if info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError("store directories must belong to the current user with mode 0700")


def main() -> int:
    if sys.argv[1:] in (["--help"], ["-h"]):
        print("Usage: python3 new-idea.py\nCreate one private idea in the existing approved local store.")
        return 0
    if sys.argv[1:]:
        print("capability-ideas: this helper takes no arguments", file=sys.stderr)
        return 2
    note = None
    try:
        check_store()
        template = TEMPLATE.read_text(encoding="utf-8")
        idea_id = "CI-" + secrets.token_hex(16)
        created = datetime.now(timezone.utc).isoformat(timespec="seconds")
        text = template.replace("{{id}}", idea_id).replace("{{created}}", created)
        os.umask(0o077)
        path = ROOT / f"{idea_id}.md"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        note = path
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
        print(path)
        return 0
    except (OSError, UnicodeError, ValueError) as error:
        detail = error.strerror if isinstance(error, OSError) else str(error)
        print(f"capability-ideas: {detail}", file=sys.stderr)
        if note is not None:
            print(f"Inspect this possibly partial local file before retrying: {note}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
