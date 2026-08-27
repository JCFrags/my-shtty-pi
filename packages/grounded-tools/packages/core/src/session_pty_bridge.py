#!/usr/bin/env python3
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

shell = sys.argv[1]
script_fd = 4
master, slave = pty.openpty()

# The detached bridge is the session leader. It owns the controlling terminal,
# and the non-interactive shell stays in the same process group. This lets one
# process-group signal clean up the bridge, shell, and command descendants.
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
os.tcsetpgrp(slave, os.getpgrp())
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
attributes = termios.tcgetattr(slave)
attributes[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, attributes)

ignored = (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP)
for sig in ignored:
    signal.signal(sig, signal.SIG_IGN)

child_pid = os.fork()
if child_pid == 0:
    for sig in ignored:
        signal.signal(sig, signal.SIG_DFL)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    if slave > 2:
        os.close(slave)
    supervisor = (
        "while IFS= read -r __grounded_payload <&4; do "
        "__grounded_script=$(printf %s \"$__grounded_payload\" | base64 -d) || exit; "
        "eval \"$__grounded_script\"; "
        "done"
    )
    os.execv(shell, [shell, "--noprofile", "--norc", "-c", supervisor])

os.close(slave)
stdin_open = True
status = None


def write_all(fd, data):
    offset = 0
    while offset < len(data):
        offset += os.write(fd, data[offset:])


while status is None:
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
        if data:
            write_all(sys.stdout.fileno(), data)
    if stdin_open and sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            write_all(master, data)
        else:
            stdin_open = False
    done, child_status = os.waitpid(child_pid, os.WNOHANG)
    if done:
        status = child_status

while True:
    try:
        data = os.read(master, 65536)
    except OSError:
        break
    if not data:
        break
    write_all(sys.stdout.fileno(), data)

os.close(master)
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(1)
