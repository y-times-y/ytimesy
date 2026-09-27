"""Forward allowlisted runtime files on Linux filesystem notifications.

The caller owns the PTY lifetime. No public guest port or provider credentials
are needed. Each connection begins with a snapshot for lossless UI recovery.
"""
import base64
import ctypes
import json
import os
import select
import sys
import time


def watch(paths, lifetime=120):
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
    if fd < 0:
        raise OSError(ctypes.get_errno(), "inotify_init1")
    try:
        for directory in {os.path.dirname(path) for path in paths.values()}:
            if libc.inotify_add_watch(fd, directory.encode(), 0x00000002 | 0x00000008 | 0x00000080 | 0x00000100) < 0:
                raise OSError(ctypes.get_errno(), "inotify_add_watch")
        previous = None
        deadline = time.monotonic() + lifetime
        while time.monotonic() < deadline:
            values = {}
            for key, path in paths.items():
                try:
                    with open(path, encoding="utf-8", errors="replace") as handle:
                        values[key] = handle.read(8 * 1024 * 1024 + 1)
                        if len(values[key]) > 8 * 1024 * 1024:
                            raise ValueError("progress file exceeded stream limit")
                except FileNotFoundError:
                    values[key] = None
            payload = json.dumps(values).encode()
            if payload != previous:
                print(base64.b64encode(payload).decode(), flush=True)
                previous = payload
            ready, _, _ = select.select([fd], [], [], min(10, max(0, deadline - time.monotonic())))
            if ready:
                os.read(fd, 65536)
            else:
                print("heartbeat", flush=True)
    finally:
        os.close(fd)


if __name__ == "__main__":
    watch(json.loads(sys.argv[1]))
