"""One-shot routing proof for a server-hosted Codex app-server and remote executor.

Runs only with an explicitly supplied, short-lived access token file. It never
prints credentials and keeps Codex state in a disposable private directory.
"""

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time


def read_messages(stream, messages):
    for line in stream:
        try:
            messages.put(json.loads(line))
        except json.JSONDecodeError:
            continue
    messages.put({"closed": True})


class AppServer:
    def __init__(self, codex_home):
        self.messages = queue.Queue()
        self.pending = []
        self.next_id = 0
        self.process = subprocess.Popen(
            [
                os.environ["CODEX_BIN"],
                "-c",
                "features.deferred_executor=true",
                "-c",
                "features.executor_capability_discovery=true",
                "app-server",
                "--listen",
                "stdio://",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env={**os.environ, "CODEX_HOME": codex_home},
        )
        threading.Thread(
            target=read_messages,
            args=(self.process.stdout, self.messages),
            daemon=True,
        ).start()

    def send(self, method, params=None, request_id=None):
        message = {"method": method, "params": params or {}}
        if request_id is not None:
            message["id"] = request_id
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def receive(self, predicate, timeout=30):
        deadline = time.monotonic() + timeout
        for index, message in enumerate(self.pending):
            if predicate(message):
                return self.pending.pop(index)
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                break
            if message.get("closed"):
                raise RuntimeError("Codex app-server closed")
            if message.get("method") == "account/chatgptAuthTokens/refresh":
                raise RuntimeError("Proof token expired; refresh through the account broker")
            if predicate(message):
                return message
            self.pending.append(message)
        raise TimeoutError("Timed out waiting for Codex app-server")

    def request(self, method, params=None, timeout=30):
        self.next_id += 1
        request_id = self.next_id
        self.send(method, params, request_id)
        reply = self.receive(lambda message: message.get("id") == request_id, timeout)
        if "error" in reply:
            raise RuntimeError(f"{method}: {reply['error']}")
        return reply["result"]

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()


def main():
    with open(os.environ["CODEX_PROOF_TOKEN_FILE"], encoding="utf-8") as source:
        tokens = json.load(source)
    workspace = os.environ["CODEX_PROOF_WORKSPACE"]
    environment_id = os.environ["CODEX_PROOF_ENVIRONMENT_ID"]
    environment = {
        "environmentId": environment_id,
        "cwd": workspace,
        "runtimeWorkspaceRoots": [workspace],
    }
    with tempfile.TemporaryDirectory(prefix="ytimesy-codex-server-proof-") as home:
        os.chmod(home, 0o700)
        server = AppServer(home)
        try:
            server.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "ytimesy",
                        "title": "ytimesy routing proof",
                        "version": "0.0.0",
                    },
                    "capabilities": {"experimentalApi": True},
                },
            )
            server.send("initialized")
            server.request(
                "environment/add",
                {
                    "environmentId": environment_id,
                    "execServerUrl": os.environ["CODEX_PROOF_EXEC_URL"],
                },
            )
            info = server.request("environment/info", {"environmentId": environment_id})
            print(json.dumps({"stage": "environment-info", "cwd": info.get("cwd")}))
            server.request(
                "account/login/start",
                {
                    "type": "chatgptAuthTokens",
                    "accessToken": tokens["accessToken"],
                    "chatgptAccountId": tokens["chatgptAccountId"],
                },
            )
            models = server.request("model/list", {"limit": 20})["data"]
            model = next(
                (item for item in models if item["id"] == "gpt-6-luna"),
                next((item for item in models if item.get("isDefault")), models[0]),
            )
            thread = server.request(
                "thread/start",
                {
                    "model": model["id"],
                    "cwd": workspace,
                    "runtimeWorkspaceRoots": [workspace],
                    "approvalPolicy": "never",
                    "sandbox": os.environ.get("CODEX_PROOF_THREAD_SANDBOX", "read-only"),
                    "ephemeral": False,
                    "environments": [environment],
                },
                timeout=60,
            )["thread"]
            print(json.dumps({"stage": "thread-started", "model": model["id"]}))
            if os.environ.get("CODEX_PROOF_DELAY_AFTER_THREAD"):
                time.sleep(int(os.environ["CODEX_PROOF_DELAY_AFTER_THREAD"]))
            server.request(
                "turn/start",
                {
                    "threadId": thread["id"],
                    "input": [
                        {
                            "type": "text",
                            "text": os.environ.get(
                                "CODEX_PROOF_PROMPT",
                                "Run `cat origin.txt` in the current directory and reply with its exact output. Do not modify files.",
                            ),
                        }
                    ],
                    "sandboxPolicy": (
                        {"type": "readOnly"}
                        if os.environ.get("CODEX_PROOF_READ_ONLY") == "1"
                        else {"type": "externalSandbox", "networkAccess": "restricted"}
                    ),
                    "environments": [environment],
                },
                timeout=60,
            )
            completion = server.receive(
                lambda message: message.get("method") == "turn/completed"
                and message.get("params", {}).get("threadId") == thread["id"],
                timeout=150,
            )
            print(
                json.dumps(
                    {
                        "stage": "turn-finished",
                        "status": completion["params"].get("turn", {}).get("status"),
                    }
                )
            )
            history = server.request(
                "thread/read", {"threadId": thread["id"], "includeTurns": True}
            )
            expected = os.environ.get("CODEX_PROOF_EXPECTED_MARKER")
            marker_found = expected in json.dumps(history["thread"]) if expected else None
            item_types = [
                item.get("type")
                for turn in history["thread"].get("turns", [])
                for item in turn.get("items", [])
                if isinstance(item, dict)
            ]
            command_results = [
                {
                    "command": item.get("command"),
                    "exitCode": item.get("exitCode"),
                    "status": item.get("status"),
                    "output": str(item.get("aggregatedOutput", ""))[:600],
                }
                for turn in history["thread"].get("turns", [])
                for item in turn.get("items", [])
                if isinstance(item, dict) and item.get("type") == "commandExecution"
            ]
            print(
                json.dumps(
                    {
                        "stage": "turn-completed",
                        "status": completion["params"].get("turn", {}).get("status"),
                        "markerFound": marker_found,
                        "itemTypes": item_types,
                        "commandResults": command_results,
                    }
                )
            )
            if expected and not marker_found:
                raise RuntimeError("The remote-only marker was absent from the turn")
        finally:
            server.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"stage": "failed", "error": str(error)}))
        sys.exit(1)
