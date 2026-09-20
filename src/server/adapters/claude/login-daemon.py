#!/usr/bin/env python3
"""Run unmodified `claude auth login --claudeai` and publish status JSON.

Claude Code has no device-code flow. This keeps the same PTY alive so the
user can paste Anthropic's callback code into that PKCE session. This
process does not host that login or collect a Claude.ai password.
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
CODE_PATH = "/tmp/ytimesy-claude-auth-code"

URL_RE = re.compile(
    r"https://(?:claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com)[^\s\"'<>\\\x00-\x1f]+"
)
PASTE_RE = re.compile(r"paste(?:\s+\w+){0,4}\s+code", re.IGNORECASE)


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


def read_paste_code() -> str | None:
    try:
        with open(CODE_PATH, "r", encoding="utf-8") as handle:
            code = handle.read().strip()
    except OSError:
        return None
    if not code:
        return None
    try:
        os.remove(CODE_PATH)
    except OSError:
        pass
    return code


def clear_paste_code() -> None:
    try:
        os.remove(CODE_PATH)
    except OSError:
        pass


def main() -> int:
    claude_bin = os.environ.get("CLAUDE_BIN") or "claude"
    clear_paste_code()
    write_status({"stage": "starting"})
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(claude_bin, [claude_bin, "auth", "login", "--claudeai"])
        os._exit(127)

    buffer = ""
    published_url = False
    sent_copy = False
    sent_code = False
    saw_paste_prompt = False
    pending_code: str | None = None
    url_published_at = 0.0
    start = time.time()
    while True:
        now = time.time()
        if not published_url and now > start + 180:
            break
        if published_url and now > url_published_at + 15 * 60:
            write_status(
                {
                    "stage": "failed",
                    "message": "Claude Code login timed out waiting for Anthropic's login code",
                }
            )
            return 1

        if pending_code is None:
            pending_code = read_paste_code()
        if sent_code:
            retry = read_paste_code()
            if retry:
                pending_code = retry
                sent_code = False

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
                url_published_at = time.time()
            lowered = buffer.lower()
            if PASTE_RE.search(buffer):
                saw_paste_prompt = True
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
        elif not published_url and not sent_copy and now > start + 15:
            try:
                os.write(fd, b"c")
            except OSError:
                pass
            sent_copy = True

        if (
            published_url
            and pending_code
            and not sent_code
            and (saw_paste_prompt or now >= url_published_at + 2)
        ):
            try:
                os.write(fd, f"{pending_code}\n".encode())
                sent_code = True
                pending_code = None
            except OSError:
                write_status(
                    {
                        "stage": "failed",
                        "message": "Claude Code login closed before the pasted code could be sent",
                    }
                )
                return 1

    if published_url:
        write_status(
            {
                "stage": "failed",
                "message": "Claude Code login ended before Anthropic accepted a login code",
            }
        )
        return 1
    write_status(
        {
            "stage": "failed",
            "message": "Claude Code did not print Anthropic's login URL",
        }
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
