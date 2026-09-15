#!/usr/bin/env python3
"""Run unmodified `claude auth login --claudeai` and publish status JSON.

The user completes Anthropic's own authorize URL. This process does not host
that login or collect a Claude.ai password.
"""

from __future__ import annotations

import json
import os
import pty
import re
import select
import time

STATUS_PATH = "/tmp/ytimesy-claude-auth-status.json"
LOG_PATH = "/tmp/ytimesy-claude-login.log"

URL_RE = re.compile(
    r"https://(?:claude\.ai|platform\.claude\.com|console\.anthropic\.com)[^\s\"'<>\\]+"
)


def write_status(payload: dict) -> None:
    tmp = f"{STATUS_PATH}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
    os.replace(tmp, STATUS_PATH)


def append_log(chunk: str) -> None:
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(chunk)


def first_anthropic_url(text: str) -> str | None:
    for match in URL_RE.finditer(text):
        url = match.group(0).rstrip(").,;")
        if "oauth" in url or "login" in url:
            return url
    return None


def main() -> int:
    claude_bin = os.environ.get("CLAUDE_BIN") or "claude"
    write_status({"stage": "starting"})
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(claude_bin, [claude_bin, "auth", "login", "--claudeai"])
        os._exit(127)

    buffer = ""
    published_url = False
    sent_copy = False
    deadline = time.time() + 180
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 1.0)
        if ready:
            try:
                chunk = os.read(fd, 4096).decode("utf-8", "replace")
            except OSError:
                break
            if not chunk:
                break
            buffer += chunk
            append_log(chunk)
            url = first_anthropic_url(buffer)
            if url and not published_url:
                write_status(
                    {
                        "stage": "awaiting_device_code",
                        "loginId": "claude-auth",
                        "verificationUrl": url,
                        "userCode": "",
                    }
                )
                published_url = True
            lowered = buffer.lower()
            if "login successful" in lowered or "logged in" in lowered:
                write_status(
                    {
                        "stage": "authenticated",
                        "authMode": "subscription",
                        "planType": None,
                        "models": [],
                    }
                )
                return 0
        elif not published_url and not sent_copy and time.time() > deadline - 165:
            try:
                os.write(fd, b"c")
            except OSError:
                pass
            sent_copy = True

    if published_url:
        write_status(
            {
                "stage": "awaiting_device_code",
                "loginId": "claude-auth",
                "verificationUrl": first_anthropic_url(buffer) or "",
                "userCode": "",
            }
        )
        return 0
    write_status(
        {
            "stage": "failed",
            "message": "Claude Code did not print Anthropic's login URL",
        }
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
