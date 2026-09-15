#!/usr/bin/env python3
import json
import os
import select
import subprocess
import sys
import time

CODEX = os.environ.get("CODEX_BIN", "codex")
STATUS_PATH = "/tmp/ytimesy-auth-status.json"
TASK_REQUEST_PATH = "/tmp/ytimesy-task-request.json"
TASK_RESULT_PATH = "/tmp/ytimesy-task-result.json"
SIDE_REQUEST_PATH = "/tmp/ytimesy-side-request.json"
SIDE_RESULT_PATH = "/tmp/ytimesy-side-result.json"
STOP_REQUEST_PATH = "/tmp/ytimesy-stop-request.json"
PROJECT_CWD_PATH = "/tmp/ytimesy-project-cwd"
DISPLAY_PATH = "/tmp/ytimesy-display"
DEVELOPER_INSTRUCTIONS_PATH = "/tmp/ytimesy-developer-instructions.txt"
TURN_PROMPT = "Reply with the single word pong and do not run any tools."
SKIP_INITIAL_TURN = os.environ.get("YTIMESY_SKIP_INITIAL_TURN") == "1"
SIDE_CHAT_PREFIX = (
    "SIDE CHAT. Answer the question. Read and search if needed. "
    "Do not edit files unless the user explicitly asks to apply a change."
    "\n\nQuestion:\n"
)


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


def is_chatgpt_account(account):
    return isinstance(account, dict) and account.get("type") == "chatgpt"


def chatgpt_account_from_cli_login():
    return {"type": "chatgpt", "planType": None}


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
    return assistant_text_from_items(collect_items_from_notifications(notifications))


def user_message_text(item):
    if isinstance(item.get("text"), str) and item["text"].strip():
        return item["text"].strip()
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    parts = []
    for part in content:
        if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"].strip():
            parts.append(part["text"].strip())
        elif isinstance(part, str) and part.strip():
            parts.append(part.strip())
    return "\n".join(parts)


def assistant_text_from_items(items):
    texts = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("type") not in ("agentMessage", "agent_message"):
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    return "\n".join(texts) if texts else None


def messages_from_items(items):
    messages = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        item_type = item.get("type")
        if item_type in ("userMessage", "user_message"):
            text = user_message_text(item)
            if text:
                messages.append({"id": item["id"], "role": "user", "text": text})
        elif item_type in ("agentMessage", "agent_message"):
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                messages.append({"id": item["id"], "role": "assistant", "text": text.strip()})
    return messages


def notification_delta(params):
    delta = params.get("delta")
    if isinstance(delta, str):
        return delta
    if isinstance(delta, dict) and isinstance(delta.get("text"), str):
        return delta["text"]
    output = params.get("output")
    if isinstance(output, str):
        return output
    text = params.get("text")
    if isinstance(text, str):
        return text
    return ""


def upsert_item(items_by_id, order, item):
    if not isinstance(item, dict):
        return
    item_id = item.get("id")
    if not isinstance(item_id, str) or not item_id:
        return
    if item_id not in items_by_id:
        order.append(item_id)
    items_by_id[item_id] = item


def ordered_items(items_by_id, order):
    return [items_by_id[item_id] for item_id in order if item_id in items_by_id]


def ensure_item(items_by_id, order, item_id, item_type):
    current = items_by_id.get(item_id)
    if isinstance(current, dict):
        return current
    created = {"id": item_id, "type": item_type}
    order.append(item_id)
    items_by_id[item_id] = created
    return created


def apply_reasoning_delta(item, params):
    delta = notification_delta(params)
    if not delta:
        return
    index = params.get("summaryIndex")
    if not isinstance(index, int):
        index = params.get("summary_index")
    if not isinstance(index, int):
        index = 0
    summary = item.get("summary")
    if not isinstance(summary, list):
        summary = []
    while len(summary) <= index:
        summary.append("")
    current = summary[index]
    if isinstance(current, str):
        summary[index] = current + delta
    elif isinstance(current, dict):
        current = dict(current)
        current["text"] = (current.get("text") or "") + delta
        summary[index] = current
    else:
        summary[index] = delta
    item["type"] = item.get("type") or "reasoning"
    item["summary"] = summary


def apply_app_server_notification(items_by_id, order, message):
    if not isinstance(message, dict):
        return
    method = message.get("method")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    item = params.get("item")
    if isinstance(item, dict):
        upsert_item(items_by_id, order, item)
    if method == "turn/completed":
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        for turn_item in turn.get("items") or []:
            upsert_item(items_by_id, order, turn_item)
    item_id = params.get("itemId") or params.get("item_id")
    if not isinstance(item_id, str) or not item_id:
        return
    if method in ("item/agentMessage/delta", "item/agent_message/delta"):
        current = ensure_item(items_by_id, order, item_id, "agentMessage")
        current["type"] = "agentMessage"
        current["text"] = (current.get("text") or "") + notification_delta(params)
        return
    if method == "item/plan/delta":
        current = ensure_item(items_by_id, order, item_id, "plan")
        current["type"] = "plan"
        current["text"] = (current.get("text") or "") + notification_delta(params)
        return
    if method in ("item/reasoning/summaryTextDelta", "item/reasoning/textDelta"):
        current = ensure_item(items_by_id, order, item_id, "reasoning")
        apply_reasoning_delta(current, params)
        return
    if method == "item/commandExecution/outputDelta":
        current = items_by_id.get(item_id)
        if isinstance(current, dict):
            current["aggregatedOutput"] = (current.get("aggregatedOutput") or "") + notification_delta(params)


def collect_items_from_notifications(notifications):
    items_by_id = {}
    order = []
    for message in notifications:
        apply_app_server_notification(items_by_id, order, message)
    return ordered_items(items_by_id, order)


def merge_session_items(session_items, incoming):
    items_by_id = {}
    order = []
    user_texts = set()
    for item in session_items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        upsert_item(items_by_id, order, item)
        if item.get("type") in ("userMessage", "user_message"):
            text = user_message_text(item)
            if text:
                user_texts.add(text)
    for item in incoming:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        if item.get("type") in ("userMessage", "user_message"):
            text = user_message_text(item)
            if text and text in user_texts and item["id"] not in items_by_id:
                continue
        upsert_item(items_by_id, order, item)
        if item.get("type") in ("userMessage", "user_message"):
            text = user_message_text(item)
            if text:
                user_texts.add(text)
    return ordered_items(items_by_id, order)


def user_message_item(item_id, text):
    return {
        "id": item_id,
        "type": "userMessage",
        "content": [{"type": "text", "text": text}],
    }


rpc_id = 100


def next_rpc_id():
    global rpc_id
    rpc_id += 1
    return rpc_id


def project_cwd():
    env = (os.environ.get("YTIMESY_PROJECT_CWD") or "").strip()
    if env and os.path.isdir(env):
        return env
    try:
        with open(PROJECT_CWD_PATH, encoding="utf-8") as handle:
            path = handle.read().strip()
        if path and os.path.isdir(path):
            return path
    except OSError:
        pass
    home = (os.environ.get("HOME") or "").strip()
    if home and os.path.isdir(home):
        return home
    return "/tmp"


def apply_display_env():
    display = ":0"
    try:
        with open(DISPLAY_PATH, encoding="utf-8") as handle:
            value = handle.read().strip()
        if value:
            display = value
    except OSError:
        pass
    os.environ["DISPLAY"] = display
    return display


def developer_instructions(cwd):
    try:
        with open(DEVELOPER_INSTRUCTIONS_PATH, encoding="utf-8") as handle:
            text = handle.read().strip()
        if text:
            return text
    except OSError:
        pass
    display = apply_display_env()
    return (
        "You are in a ytimesy workspace VM. The project checkout is %s; work there. "
        "This VM has a shared Linux desktop on DISPLAY=%s. The user watches and can "
        "control that same screen from the Desktop tab. Use that display for QA and "
        "computer-use: open the browser there, click, type, and screenshot there. "
        "GUI commands must export DISPLAY=%s. Browser: chromium --no-sandbox, "
        "chromium-browser --no-sandbox, or google-chrome --no-sandbox. "
        "Pointer/keyboard: xdotool. Screenshots: scrot."
        % (cwd, display, display)
    )


def start_thread(proc, model_id, cwd=None):
    cwd = cwd or project_cwd()
    apply_display_env()
    params = {
        "model": model_id,
        "cwd": cwd,
        "approvalPolicy": "never",
        "sandbox": "danger-full-access",
        "developerInstructions": developer_instructions(cwd),
    }
    thread_id, error = request_thread_start(proc, params)
    if thread_id:
        return thread_id, None
    if error and "developerInstructions" in error:
        params.pop("developerInstructions", None)
        thread_id, error = request_thread_start(proc, params)
        if thread_id:
            return thread_id, None
    return None, error or "thread/start failed"


def request_thread_start(proc, params):
    request_id = next_rpc_id()
    send(
        proc,
        {
            "method": "thread/start",
            "id": request_id,
            "params": params,
        },
    )
    thread_message, _ = wait_for_id(proc, request_id, 45)
    if "error" in thread_message:
        return None, thread_message["error"].get("message", "thread/start failed")
    thread = {}
    if isinstance(thread_message.get("result"), dict):
        thread = thread_message["result"].get("thread") or {}
    thread_id = thread.get("id") if isinstance(thread, dict) else None
    if not thread_id:
        return None, "thread/start did not return a thread id"
    return thread_id, None


def consume_stop_request():
    if not os.path.exists(STOP_REQUEST_PATH):
        return False
    try:
        os.remove(STOP_REQUEST_PATH)
    except FileNotFoundError:
        return False
    return True


def request_turn_interrupt(proc, thread_id):
    request_id = next_rpc_id()
    send(
        proc,
        {
            "method": "turn/interrupt",
            "id": request_id,
            "params": {"threadId": thread_id},
        },
    )
    try:
        wait_for_id(proc, request_id, 8)
    except TimeoutError:
        pass


def run_turn(proc, thread_id, model_id, text, on_items=None):
    apply_display_env()
    request_id = next_rpc_id()
    send(
        proc,
        {
            "method": "turn/start",
            "id": request_id,
            "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": text}],
                "approvalPolicy": "never",
                "sandboxPolicy": {"type": "dangerFullAccess"},
            },
        },
    )
    items_by_id = {}
    order = []

    def note(message):
        apply_app_server_notification(items_by_id, order, message)
        if on_items:
            on_items(ordered_items(items_by_id, order))

    turn_message, notifications = wait_for_id(proc, request_id, 180)
    for message in notifications:
        note(message)
    if "error" in turn_message:
        return {
            "threadId": thread_id,
            "modelId": model_id,
            "status": "error",
            "text": turn_message["error"].get("message"),
            "error": turn_message["error"].get("message"),
        }
    turn_obj = find_completed_turn(notifications)
    deadline = time.time() + 180
    while turn_obj is None and time.time() < deadline:
        if consume_stop_request():
            request_turn_interrupt(proc, thread_id)
        try:
            message = read_message(proc, min(15.0, deadline - time.time()))
        except TimeoutError:
            continue
        notifications.append(message)
        note(message)
        turn_obj = find_completed_turn(notifications)
    if turn_obj is None:
        turn_status = "timeout"
    else:
        turn_status = turn_obj.get("status") or "completed"
    items = ordered_items(items_by_id, order)
    if on_items:
        on_items(items)
    return {
        "threadId": thread_id,
        "modelId": model_id,
        "status": turn_status,
        "text": assistant_text_from_items(items),
        "error": turn_error_message(turn_obj, notifications),
    }


def read_json_file(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_json_file(path, payload):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
    os.replace(temporary, path)


def read_account_once(proc, request_id, refresh_token, timeout=20):
    send(
        proc,
        {
            "method": "account/read",
            "id": request_id,
            "params": {"refreshToken": refresh_token},
        },
    )
    message, _ = wait_for_id(proc, request_id, timeout)
    if "error" in message:
        return None, message["error"].get("message", "account/read failed")
    return account_from_result(message.get("result")), None


def read_chatgpt_account(proc, timeout=45):
    """Reads the ChatGPT account from the live access token first.

    ChatGPT refresh tokens are single-use. Looping account/read with
    refreshToken=true after a snapshot boot burns the snapshotted token and
    then looks logged-out even when CLI login and the access token are valid.
    Refresh at most once, and only if the unrefreshed read never returned
    type=chatgpt.
    """
    deadline = time.time() + timeout
    request_id = 50
    last_account = None
    last_error = None
    while time.time() < deadline:
        request_id += 1
        account, error = read_account_once(proc, request_id, False)
        if error:
            last_error = error
            time.sleep(1)
            continue
        last_error = None
        last_account = account
        if is_chatgpt_account(account):
            return account
        time.sleep(1)
    request_id += 1
    account, error = read_account_once(proc, request_id, True)
    if is_chatgpt_account(account):
        return account
    if error and last_account is None:
        fail(error, stageDetail="accountRead")
    if last_error and last_account is None and not error:
        fail(last_error, stageDetail="accountRead")
    return last_account if last_account is not None else account


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
    env = os.environ.copy()
    env["DISPLAY"] = apply_display_env()
    proc = subprocess.Popen(
        [CODEX, "app-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=error_log,
        text=True,
        bufsize=1,
        env=env,
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
        if not is_chatgpt_account(account):
            if already_logged_in:
                account = chatgpt_account_from_cli_login()
            else:
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

        if not is_chatgpt_account(account):
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
        listed = [{"id": model["id"], "label": model["label"]} for model in models]
        turn = None
        thread_id = None
        thread_cwd = None
        session_items = []
        turn_status = "idle"
        active_task_id = None
        side_turn = None
        side_thread_id = None
        side_thread_cwd = None
        side_items = []
        side_turn_status = "idle"
        side_active_task_id = None

        def publish(current_turn):
            write_status(
                {
                    "stage": "authenticated",
                    "authMode": "chatgpt",
                    "planType": account.get("planType"),
                    "codexVersion": version,
                    "models": listed,
                    "turn": current_turn,
                    "turnStatus": turn_status,
                    "activeTaskId": active_task_id,
                    "items": session_items,
                    "messages": messages_from_items(session_items),
                    "sideTurn": side_turn,
                    "sideTurnStatus": side_turn_status,
                    "sideActiveTaskId": side_active_task_id,
                    "sideItems": side_items,
                }
            )

        def finish_request(path, result_path, request_id, result):
            write_json_file(result_path, {"id": request_id, "turn": result})
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

        if model_id and not SKIP_INITIAL_TURN:
            thread_cwd = project_cwd()
            thread_id, thread_error = start_thread(proc, model_id, thread_cwd)
            if thread_id:
                turn_status = "running"
                session_items = [user_message_item("user-initial", TURN_PROMPT)]
                publish(None)

                def on_initial_items(turn_items):
                    nonlocal session_items
                    session_items = merge_session_items(session_items, turn_items)
                    publish(turn)

                turn = run_turn(
                    proc, thread_id, model_id, TURN_PROMPT, on_items=on_initial_items
                )
                turn_status = (
                    "failed"
                    if turn.get("status") in ("error", "timeout", "failed")
                    else "completed"
                )
            elif thread_error:
                turn_status = "failed"
                turn = {
                    "threadId": "",
                    "modelId": model_id,
                    "status": "error",
                    "text": thread_error,
                    "error": thread_error,
                }

        publish(turn)
        while True:
            request = read_json_file(TASK_REQUEST_PATH)
            if isinstance(request, dict) and request.get("id") and request.get("text"):
                requested_model = request.get("modelId") or model_id
                if requested_model:
                    model_id = requested_model
                cwd = project_cwd()
                if thread_id and thread_cwd != cwd:
                    thread_id = None
                if not thread_id and model_id:
                    thread_id, thread_error = start_thread(proc, model_id, cwd)
                    thread_cwd = cwd
                    if thread_error and not thread_id:
                        turn_status = "failed"
                        active_task_id = None
                        turn = {
                            "threadId": "",
                            "modelId": model_id or "",
                            "status": "error",
                            "text": thread_error,
                            "error": thread_error,
                        }
                        finish_request(
                            TASK_REQUEST_PATH, TASK_RESULT_PATH, request["id"], turn
                        )
                        publish(turn)
                        time.sleep(0.4)
                        continue
                if thread_id and model_id:
                    active_task_id = request["id"]
                    turn_status = "running"
                    session_items = merge_session_items(
                        session_items,
                        [user_message_item("user-%s" % request["id"], request["text"])],
                    )
                    publish(turn)

                    def on_task_items(turn_items):
                        nonlocal session_items
                        session_items = merge_session_items(session_items, turn_items)
                        publish(turn)

                    turn = run_turn(
                        proc,
                        thread_id,
                        model_id,
                        request["text"],
                        on_items=on_task_items,
                    )
                    turn_status = (
                        "failed"
                        if turn.get("status") in ("error", "timeout", "failed")
                        else "completed"
                    )
                    active_task_id = None
                    finish_request(
                        TASK_REQUEST_PATH, TASK_RESULT_PATH, request["id"], turn
                    )
                    publish(turn)
                    time.sleep(0.4)
                    continue

            if turn_status != "running":
                side_request = read_json_file(SIDE_REQUEST_PATH)
                if (
                    isinstance(side_request, dict)
                    and side_request.get("id")
                    and side_request.get("text")
                ):
                    requested_model = side_request.get("modelId") or model_id
                    if requested_model:
                        model_id = requested_model
                    cwd = project_cwd()
                    if side_thread_id and side_thread_cwd != cwd:
                        side_thread_id = None
                    if not side_thread_id and model_id:
                        side_thread_id, side_thread_error = start_thread(
                            proc, model_id, cwd
                        )
                        side_thread_cwd = cwd
                        if side_thread_error and not side_thread_id:
                            side_turn_status = "failed"
                            side_active_task_id = None
                            side_turn = {
                                "threadId": "",
                                "modelId": model_id or "",
                                "status": "error",
                                "text": side_thread_error,
                                "error": side_thread_error,
                            }
                            finish_request(
                                SIDE_REQUEST_PATH,
                                SIDE_RESULT_PATH,
                                side_request["id"],
                                side_turn,
                            )
                            publish(turn)
                            time.sleep(0.4)
                            continue
                    if side_thread_id and model_id:
                        side_active_task_id = side_request["id"]
                        side_turn_status = "running"
                        question = side_request["text"]
                        side_items = merge_session_items(
                            side_items,
                            [user_message_item("side-%s" % side_request["id"], question)],
                        )
                        publish(turn)

                        def on_side_items(turn_items):
                            nonlocal side_items
                            side_items = merge_session_items(side_items, turn_items)
                            publish(turn)

                        side_turn = run_turn(
                            proc,
                            side_thread_id,
                            model_id,
                            SIDE_CHAT_PREFIX + question,
                            on_items=on_side_items,
                        )
                        side_turn_status = (
                            "failed"
                            if side_turn.get("status") in ("error", "timeout", "failed")
                            else "completed"
                        )
                        side_active_task_id = None
                        finish_request(
                            SIDE_REQUEST_PATH,
                            SIDE_RESULT_PATH,
                            side_request["id"],
                            side_turn,
                        )
                        publish(turn)
            time.sleep(0.4)
    except Exception as exc:
        fail(str(exc), stageDetail="loginDaemon")
    finally:
        error_log.close()


if __name__ == "__main__":
    main()
