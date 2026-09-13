#!/usr/bin/env python3
import json
import os
import select
import subprocess
import sys
import time

CODEX = os.environ.get("CODEX_BIN", "codex")
STATUS_PATH = "/tmp/ytimesy-auth-status.json"
TURN_PROMPT = "Reply with the single word pong and do not run any tools."


def write_status(payload):
    temporary = STATUS_PATH + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
    os.replace(temporary, STATUS_PATH)


def fail(message, **extra):
    payload = {"stage": "failed", "message": message}
    payload.update(extra)
    write_status(payload)
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
        if not chunk.endswith("\n"):
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
    notifications = []
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise TimeoutError("timed out waiting for response id %s" % target_id)
        message = read_message(proc, remaining)
        if message.get("id") == target_id:
            return message, notifications
        if message.get("method"):
            notifications.append(message)


def send(proc, payload):
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()


def account_from_result(result):
    if not isinstance(result, dict):
        return None
    account = result.get("account")
    if isinstance(account, dict):
        return account
    if result.get("type") == "chatgpt":
        return result
    return None


def listed_models(result):
    if not isinstance(result, dict):
        return []
    rows = result.get("data")
    if not isinstance(rows, list):
        return []
    models = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        model_id = row.get("id") or row.get("model")
        if not isinstance(model_id, str) or not model_id:
            continue
        label = row.get("displayName")
        models.append(
            {
                "id": model_id,
                "label": label if isinstance(label, str) and label else model_id,
                "isDefault": bool(row.get("isDefault")),
            }
        )
    return models


PREFERRED_MODEL_ID = os.environ.get("CODEX_PREFERRED_MODEL", "gpt-5.3-codex-spark")


def choose_model(models):
    if PREFERRED_MODEL_ID:
        for model in models:
            if model["id"] == PREFERRED_MODEL_ID:
                return model["id"]
    for model in models:
        if model.get("isDefault"):
            return model["id"]
    if models:
        return models[0]["id"]
    return None


def find_completed_turn(notifications):
    for message in notifications:
        if message.get("method") != "turn/completed":
            continue
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        turn_obj = params.get("turn") if isinstance(params.get("turn"), dict) else params
        if isinstance(turn_obj, dict):
            return turn_obj
    return None


def turn_error_message(turn_obj, notifications):
    if isinstance(turn_obj, dict):
        err = turn_obj.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            return err["message"]
        if isinstance(err, str) and err:
            return err
    for message in notifications:
        if message.get("method") != "error":
            continue
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        err = params.get("error") if isinstance(params.get("error"), dict) else params
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            return err["message"]
        if isinstance(params.get("message"), str):
            return params["message"]
    return None


def collect_turn_text(notifications):
    texts = []
    for message in notifications:
        if message.get("method") != "item/completed":
            continue
        params = message.get("params")
        if not isinstance(params, dict):
            continue
        item = params.get("item")
        if not isinstance(item, dict):
            continue
        if item.get("type") not in ("agentMessage", "agent_message"):
            continue
        text = item.get("text") or item.get("content")
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    return "\n".join(texts) if texts else None


def read_chatgpt_account(proc, timeout=45):
    deadline = time.time() + timeout
    request_id = 50
    last_account = None
    last_error = None
    while time.time() < deadline:
        request_id += 1
        send(
            proc,
            {
                "method": "account/read",
                "id": request_id,
                "params": {"refreshToken": True},
            },
        )
        message, _ = wait_for_id(proc, request_id, 20)
        if "error" in message:
            last_error = message["error"].get("message", "account/read failed")
            time.sleep(1)
            continue
        last_error = None
        last_account = account_from_result(message.get("result"))
        if last_account and last_account.get("type") == "chatgpt":
            return last_account
        time.sleep(1)
    if last_error:
        fail(last_error, stageDetail="accountRead")
    return last_account


def wait_for_login(proc, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        remaining = max(1.0, deadline - time.time())
        try:
            message = read_message(proc, min(15.0, remaining))
        except TimeoutError:
            continue
        method = message.get("method")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if method == "account/login/completed":
            if params.get("success") is True:
                return params
            fail(
                params.get("error") or "ChatGPT device-code login did not complete",
                login=params,
            )
        if method == "account/updated" and params.get("authMode") == "chatgpt":
            return params
    fail("Timed out waiting for ChatGPT device-code authorization")


def cli_has_chatgpt_login():
    result = subprocess.run(
        [CODEX, "login", "status"],
        capture_output=True,
        text=True,
    )
    output = (result.stdout or "") + (result.stderr or "")
    return "Logged in using ChatGPT" in output


def main():
    version = os.environ.get("CODEX_VERSION")
    write_status({"stage": "starting", "codexVersion": version})
    error_log = open("/tmp/ytimesy-app-server.err", "w", encoding="utf-8")
    proc = subprocess.Popen(
        [CODEX, "app-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=error_log,
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
                    }
                },
            },
        )
        initialized, _ = wait_for_id(proc, 0, 30)
        if "error" in initialized:
            fail(initialized["error"].get("message", "initialize failed"), stageDetail="initialize")
        send(proc, {"method": "initialized", "params": {}})
        already_logged_in = cli_has_chatgpt_login()
        account = read_chatgpt_account(proc, timeout=45 if already_logged_in else 8)
        if not (account and account.get("type") == "chatgpt"):
            if already_logged_in:
                fail(
                    "Codex CLI has a ChatGPT login, but app-server account/read did not return a ChatGPT account",
                    stageDetail="accountRead",
                )
            send(
                proc,
                {
                    "method": "account/login/start",
                    "id": 4,
                    "params": {"type": "chatgptDeviceCode"},
                },
            )
            login, _ = wait_for_id(proc, 4, 45)
            if "error" in login:
                fail(
                    login["error"].get("message", "account/login/start failed"),
                    stageDetail="loginStart",
                    login=login,
                )
            result = login.get("result") if isinstance(login.get("result"), dict) else {}
            user_code = result.get("userCode")
            verification_url = result.get("verificationUrl")
            login_id = result.get("loginId")
            if not user_code or not verification_url or not login_id:
                fail(
                    "chatgptDeviceCode response was missing loginId, verificationUrl, or userCode",
                    login=result,
                )
            write_status(
                {
                    "stage": "awaiting_device_code",
                    "loginId": login_id,
                    "verificationUrl": verification_url,
                    "userCode": user_code,
                    "codexVersion": version,
                }
            )
            wait_for_login(proc, 12 * 60)
            account = read_chatgpt_account(proc, timeout=45)

        if not account or account.get("type") != "chatgpt":
            fail(
                "Login finished without a ChatGPT account",
                accountType=None if not account else account.get("type"),
            )

        send(proc, {"method": "model/list", "id": 7, "params": {"limit": 50, "includeHidden": False}})
        models_message, _ = wait_for_id(proc, 7, 45)
        models = []
        if "error" not in models_message:
            models = listed_models(models_message.get("result"))
        model_id = choose_model(models)
        turn = None
        if model_id:
            send(
                proc,
                {
                    "method": "thread/start",
                    "id": 10,
                    "params": {
                        "model": model_id,
                        "cwd": "/tmp",
                        "approvalPolicy": "never",
                        "sandbox": "danger-full-access",
                    },
                },
            )
            thread_message, _ = wait_for_id(proc, 10, 45)
            thread = {}
            if "error" not in thread_message and isinstance(thread_message.get("result"), dict):
                thread = thread_message["result"].get("thread") or {}
            thread_id = thread.get("id") if isinstance(thread, dict) else None
            if thread_id:
                send(
                    proc,
                    {
                        "method": "turn/start",
                        "id": 11,
                        "params": {
                            "threadId": thread_id,
                            "input": [{"type": "text", "text": TURN_PROMPT}],
                            "approvalPolicy": "never",
                            "sandboxPolicy": {"type": "dangerFullAccess"},
                        },
                    },
                )
                turn_message, notifications = wait_for_id(proc, 11, 30)
                turn_status = "started"
                turn_obj = find_completed_turn(notifications)
                if "error" in turn_message:
                    turn_status = "error"
                    assistant = turn_message["error"].get("message")
                    error_text = assistant
                else:
                    assistant = None
                    error_text = None
                    deadline = time.time() + 180
                    while turn_obj is None and time.time() < deadline:
                        try:
                            message = read_message(proc, min(15.0, deadline - time.time()))
                        except TimeoutError:
                            continue
                        notifications.append(message)
                        turn_obj = find_completed_turn(notifications)
                    if turn_obj is None:
                        turn_status = "timeout"
                    else:
                        turn_status = turn_obj.get("status") or "completed"
                    assistant = collect_turn_text(notifications)
                    error_text = turn_error_message(turn_obj, notifications)
                turn = {
                    "threadId": thread_id,
                    "modelId": model_id,
                    "status": turn_status,
                    "text": assistant,
                    "error": error_text,
                }

        write_status(
            {
                "stage": "authenticated",
                "authMode": "chatgpt",
                "planType": account.get("planType"),
                "codexVersion": version,
                "models": [{"id": model["id"], "label": model["label"]} for model in models],
                "turn": turn,
            }
        )
        # Keep app-server alive so a follow-up can inspect the session.
        while True:
            time.sleep(30)
    except Exception as exc:
        fail(str(exc), stageDetail="loginDaemon")
    finally:
        error_log.close()


if __name__ == "__main__":
    main()
