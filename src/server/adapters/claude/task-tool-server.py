#!/usr/bin/env python3
import json
import os
import sys
import time

REQUEST_PATH = "/tmp/ytimesy-agent-task-tool-request.json"
RESPONSE_PATH = "/tmp/ytimesy-agent-task-tool-response.json"

TASK_TOOL_DEFINITIONS = [] # YTIMESY_TASK_TOOL_DEFINITIONS
TOOLS = TASK_TOOL_DEFINITIONS


def send(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def write_json(path, payload):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
    os.replace(temporary, path)


def call_tool(name, arguments):
    call_id = "claude-%s" % time.time_ns()
    write_json(
        REQUEST_PATH,
        {"id": call_id, "tool": name, "arguments": arguments},
    )
    deadline = time.time() + 180
    while time.time() < deadline:
        response = read_json(RESPONSE_PATH)
        if isinstance(response, dict) and response.get("id") == call_id:
            ok = bool(response.get("ok"))
            output = response.get("result") if ok else response.get("error")
            return {
                "content": [{"type": "text", "text": json.dumps(output)}],
                "isError": not ok,
            }
        time.sleep(0.25)
    return {
        "content": [{"type": "text", "text": "Task orchestration timed out."}],
        "isError": True,
    }


def handle(message):
    request_id = message.get("id")
    method = message.get("method")
    if method == "initialize":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "ytimesy-tasks", "version": "1"},
                },
            }
        )
        return
    if method == "tools/list":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}})
        return
    if method == "tools/call":
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        name = params.get("name")
        arguments = params.get("arguments")
        known = any(tool["name"] == name for tool in TOOLS)
        if not known or not isinstance(arguments, dict):
            result = {
                "content": [{"type": "text", "text": "Invalid task tool request."}],
                "isError": True,
            }
        else:
            result = call_tool(name, arguments)
        send({"jsonrpc": "2.0", "id": request_id, "result": result})
        return
    if request_id is not None:
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": "Method not found"},
            }
        )


def main():
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(message, dict):
            handle(message)


if __name__ == "__main__":
    main()
