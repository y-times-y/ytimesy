export const CODEX_JSONRPC_PROBE_SCRIPT = `#!/usr/bin/env python3
import json
import os
import select
import subprocess
import sys
import time

CODEX = os.environ.get("CODEX_BIN", "codex")
MARKER = "YTIMESY_PROOF="


def emit(payload):
    sys.stdout.write(MARKER + json.dumps(payload) + "\\n")
    sys.stdout.flush()


def fail(stage, error, **extra):
    payload = {"ok": False, "stage": stage, "error": error}
    payload.update(extra)
    emit(payload)
    sys.exit(0)


def read_message(proc, timeout):
    deadline = time.time() + timeout
    buffer = ""
    while time.time() < deadline:
        remaining = max(0.05, deadline - time.time())
        ready, _, _ = select.select([proc.stdout], [], [], remaining)
        if not ready:
            continue
        chunk = proc.stdout.readline()
        if chunk == "":
            raise RuntimeError("codex app-server closed stdout")
        buffer += chunk
        if not chunk.endswith("\\n"):
            continue
        line = buffer.strip()
        buffer = ""
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise TimeoutError("timed out waiting for app-server JSON")


def wait_for_id(proc, target_id, timeout):
    deadline = time.time() + timeout
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise TimeoutError("timed out waiting for response id %s" % target_id)
        message = read_message(proc, remaining)
        if message.get("id") == target_id:
            return message


def send(proc, payload):
    proc.stdin.write(json.dumps(payload) + "\\n")
    proc.stdin.flush()


def main():
    version = os.environ.get("CODEX_VERSION")
    proc = subprocess.Popen(
        [CODEX, "app-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    try:
        send(
            proc,
            {
                "method": "initialize",
                "id": 0,
                "params": {
                    "clientInfo": {
                        "name": "ytimesy",
                        "title": "ytimesy",
                        "version": "0.0.0",
                    },
                    "capabilities": {
                        "experimentalApi": True,
                        "requestAttestation": False,
                    },
                },
            },
        )
        initialized = wait_for_id(proc, 0, 30)
        if "error" in initialized:
            fail(
                "initialize",
                initialized["error"].get("message", "initialize failed"),
                initialize=initialized,
                codexVersion=version,
            )
        send(proc, {"method": "initialized", "params": {}})
        send(proc, {"method": "account/read", "id": 1, "params": {"refreshToken": False}})
        account = wait_for_id(proc, 1, 30)
        if "error" in account:
            fail(
                "accountRead",
                account["error"].get("message", "account/read failed"),
                initialize=initialized.get("result"),
                account=account,
                codexVersion=version,
            )
        send(
            proc,
            {
                "method": "account/login/start",
                "id": 4,
                "params": {"type": "chatgptDeviceCode"},
            },
        )
        login = wait_for_id(proc, 4, 45)
        if "error" in login:
            fail(
                "loginStart",
                login["error"].get("message", "account/login/start failed"),
                initialize=initialized.get("result"),
                account=account.get("result"),
                login=login,
                codexVersion=version,
            )
        result = login.get("result")
        login_id = None
        if isinstance(result, dict):
            login_id = result.get("loginId")
        if login_id:
            send(
                proc,
                {
                    "method": "account/login/cancel",
                    "id": 5,
                    "params": {"loginId": login_id},
                },
            )
            try:
                wait_for_id(proc, 5, 10)
            except Exception:
                pass
        emit(
            {
                "ok": True,
                "stage": "loginStart",
                "codexVersion": version,
                "initialize": initialized.get("result"),
                "account": account.get("result"),
                "login": result,
                "notes": [
                    "Device-code login was cancelled after the payload was observed.",
                    "turn/start was not called because ChatGPT login was not completed.",
                ],
            }
        )
    except Exception as exc:
        fail("initialize", str(exc), codexVersion=version)
    finally:
        proc.kill()


if __name__ == "__main__":
    main()
`;
