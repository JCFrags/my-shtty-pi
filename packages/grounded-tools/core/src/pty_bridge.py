#!/usr/bin/env python3
import base64
import os
import pty
import select
import signal
import sys

shell = sys.argv[1]
command = base64.b64decode(sys.argv[2]).decode("utf-8")
child_pid, master = pty.fork()
if child_pid == 0:
    os.execv(shell, [shell, "-lc", command])


def forward(sig, _frame):
    try:
        os.kill(child_pid, sig)
    except ProcessLookupError:
        pass


for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, forward)

stdin_open = True
while True:
    readers = [master]
    if stdin_open:
        readers.append(sys.stdin.fileno())
    try:
        ready, _, _ = select.select(readers, [], [], 0.1)
    except InterruptedError:
        continue
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if stdin_open and sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            os.write(master, data)
        else:
            stdin_open = False
    done, status = os.waitpid(child_pid, os.WNOHANG)
    if done:
        while True:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
        if os.WIFEXITED(status):
            sys.exit(os.WEXITSTATUS(status))
        if os.WIFSIGNALED(status):
            sys.exit(128 + os.WTERMSIG(status))

_, status = os.waitpid(child_pid, 0)
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
sys.exit(128 + os.WTERMSIG(status))
