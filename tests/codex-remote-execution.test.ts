import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

function runCase(test: string) {
	return execFileSync(
		"python3",
		[
			"-c",
			`import os, runpy
os.environ["YTIMESY_REMOTE_EXEC_URL"] = "wss://executor.internal.example"
os.environ["YTIMESY_REMOTE_ENVIRONMENT_ID"] = "task-vm"
os.environ["YTIMESY_PROJECT_CWD"] = "/home/ubuntu/repo"
module = runpy.run_path("src/server/adapters/codex/login-daemon.py")
env = module["run_turn"].__globals__
env["apply_display_env"] = lambda: None
env["consume_stop_request"] = lambda: False
sent = []
env["send"] = lambda proc, payload: sent.append(payload)
${test}
print("ok")`,
		],
		{ encoding: "utf8", timeout: 5000 },
	).trim();
}

it("attaches the remote environment to a new thread", () => {
	expect(
		runCase(`env["wait_for_id"] = lambda proc, request_id, timeout: ({"result":{"thread":{"id":"thread"}}}, [])
thread_id, error = env["start_thread"](None, "model")
assert thread_id == "thread" and error is None
params = sent[0]["params"]
assert params["cwd"] == "/home/ubuntu/repo"
assert params["environments"][0]["environmentId"] == "task-vm"
assert params["runtimeWorkspaceRoots"] == ["/home/ubuntu/repo"]`),
	).toBe("ok");
});

it("resumes the stored thread with the same remote environment", () => {
	expect(
		runCase(`env["wait_for_id"] = lambda proc, request_id, timeout: ({"result":{"thread":{"id":"old-thread"}}}, [])
assert env["resume_thread"](None, "old-thread", "/home/ubuntu/repo")
request = sent[0]
assert request["method"] == "thread/resume"
assert request["params"]["threadId"] == "old-thread"
assert request["params"]["environments"][0]["environmentId"] == "task-vm"`),
	).toBe("ok");
});

it("enforces read-only policy on remote turns", () => {
	expect(
		runCase(`env["check_remote_executor"] = lambda proc: None
ack = {"id":101,"result":{"turn":{"id":"turn"}}}
completed = {"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}
messages = iter([ack, completed])
env["read_message"] = lambda proc, timeout: next(messages)
result = env["run_turn"](None, "thread", "model", "prompt", read_only=True)
assert result["status"] == "completed"
params = next(item["params"] for item in sent if item["method"] == "turn/start")
assert params["sandboxPolicy"] == {"type":"readOnly"}
assert params["environments"][0]["environmentId"] == "task-vm"`),
	).toBe("ok");
});

it("terminates only this cancelled turn's native terminals, not older thread processes", () => {
	expect(
		runCase(`replies = iter([
 ({"result":{"data":[{"itemId":"active","processId":"42"},{"itemId":"older","processId":"41"}],"nextCursor":"next"}}, []),
 ({"result":{"terminated":True}}, []),
 ({"result":{"data":[],"nextCursor":None}}, [])
])
env["wait_for_id"] = lambda proc, request_id, timeout: next(replies)
env["terminate_turn_terminals"](None, "thread", [{"id":"active","type":"commandExecution"}])
assert [m["method"] for m in sent] == ["thread/backgroundTerminals/list","thread/backgroundTerminals/terminate","thread/backgroundTerminals/list"]
assert sent[1]["params"] == {"threadId":"thread","processId":"42"}
assert sent[2]["params"]["cursor"] == "next"`),
	).toBe("ok");
});

it("fails before sending a turn when the remote executor is unavailable", () => {
	expect(
		runCase(`env["check_remote_executor"] = lambda proc, connect=False: "Executor disconnected"
result = env["run_turn"](None, "thread", "model", "prompt")
assert result["status"] == "failed"
assert result["error"] == "Executor disconnected"
assert sent == []`),
	).toBe("ok");
});

it("marks a completed text-only turn failed if execution disconnects", () => {
	expect(
		runCase(`checks = iter([None, "Executor disconnected"])
env["check_remote_executor"] = lambda proc: next(checks)
ack = {"id":101,"result":{"turn":{"id":"turn"}}}
completed = {"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}
messages = iter([ack, completed])
env["read_message"] = lambda proc, timeout: next(messages)
result = env["run_turn"](None, "thread", "model", "prompt")
assert result["status"] == "failed"
assert result["error"] == "Executor disconnected"
params = next(item["params"] for item in sent if item["method"] == "turn/start")
assert params["sandboxPolicy"] == {"type":"externalSandbox","networkAccess":"restricted"}
assert params["environments"][0]["environmentId"] == "task-vm"`),
	).toBe("ok");
});

it("reconnects a cold executor only before dispatching a turn", () => {
	expect(
		runCase(`checks = []
def check(proc, connect=False):
    checks.append(connect)
    return "Executor disconnected" if len(checks) == 1 else None
env["check_remote_executor"] = check
messages = iter([{"id":101,"result":{"turn":{"id":"turn"}}}, {"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}])
env["read_message"] = lambda proc, timeout: next(messages)
result = env["run_turn"](None, "thread", "model", "prompt")
assert result["status"] == "completed"
assert checks == [False, True, False]
assert len([m for m in sent if m["method"] == "turn/start"]) == 1`),
	).toBe("ok");
});

it("does not replay an in-flight request after a process restart", () => {
	expect(
		runCase(`import json, pathlib, tempfile
with tempfile.TemporaryDirectory() as directory:
    request = pathlib.Path(directory) / "request.json"
    result = pathlib.Path(directory) / "result.json"
    request.write_text(json.dumps({"id":"turn-1","text":"edit files"}))
    assert not env["fail_interrupted_request"](str(request), str(result), "turn-2")
    assert request.exists() and not result.exists()
    assert env["fail_interrupted_request"](str(request), str(result), "turn-1")
    assert not request.exists()
    assert json.loads(result.read_text())["turn"]["status"] == "failed"`),
	).toBe("ok");
});

it("interrupts and fails a quiet remote turn within the health deadline", () => {
	expect(
		runCase(`import types
clock = [0]
env["time"] = types.SimpleNamespace(monotonic=lambda: clock[0])
env["check_remote_executor"] = lambda proc: None
def read(proc, timeout):
    clock[0] += timeout
    raise TimeoutError("no events")
env["read_message"] = read
result = env["run_turn"](None, "thread", "model", "prompt")
assert result["status"] == "failed"
assert "executor disconnected" in result["error"]
assert clock[0] <= 3.1, clock
assert any(m["method"] == "environment/status" for m in sent)
assert not any(m["method"] == "turn/interrupt" for m in sent)`),
	).toBe("ok");
});

it("keeps streaming during successful heartbeats without a second reader", () => {
	expect(
		runCase(`import types
clock = [0]
env["time"] = types.SimpleNamespace(monotonic=lambda: clock[0])
env["check_remote_executor"] = lambda proc: None
calls = [0]
def read(proc, timeout):
    calls[0] += 1
    clock[0] += 0.25
    if calls[0] <= 4:
        raise TimeoutError("quiet reasoning")
    if calls[0] == 5:
        return {"id":sent[-1]["id"], "result":{"status":"ready"}}
    if calls[0] == 6:
        return {"method":"item/agentMessage/delta", "params":{"threadId":"thread", "itemId":"answer", "delta":"Hello"}}
    return {"method":"turn/completed", "params":{"threadId":"thread", "turn":{"status":"completed"}}}
env["read_message"] = read
progress = []
result = env["run_turn"](None, "thread", "model", "prompt", on_items=lambda items: progress.append(items))
assert result["status"] == "completed"
assert result["text"] == "Hello"
assert not any(m["method"] == "turn/interrupt" for m in sent)
assert progress`),
	).toBe("ok");
});

it("fails immediately on a rejected executor heartbeat and stops the harness", () => {
	expect(
		runCase(`import types
clock = [0]
env["time"] = types.SimpleNamespace(monotonic=lambda: clock[0])
env["check_remote_executor"] = lambda proc: None
killed = []
proc = types.SimpleNamespace(poll=lambda: None, kill=lambda: killed.append(True))
def read(proc, timeout):
    clock[0] += 1
    if clock[0] <= 1: raise TimeoutError("quiet")
    return {"id":sent[-1]["id"], "error":{"message":"executor gone"}}
env["read_message"] = read
result = env["run_turn"](proc, "thread", "model", "prompt")
assert result["status"] == "failed"
assert killed == [True]`),
	).toBe("ok");
});

it("does not mistake a long application tool handler for an executor timeout", () => {
	expect(
		runCase(`import types
clock = [0]
env["time"] = types.SimpleNamespace(monotonic=lambda: clock[0])
proc = types.SimpleNamespace(pid=1)
health = env["RemoteExecutorHealth"](proc)
clock[0] = 1
assert health.check(proc) is None
request_id = sent[-1]["id"]
clock[0] = 181
env["APP_SERVER_SERVICE_SECONDS"][1] = 180
assert health.check(proc) is None
handled, error = health.receive({"id":request_id,"result":{"status":"ready"}})
assert handled and error is None`),
	).toBe("ok");
});

it("fails immediately on the matching native disconnection event", () => {
	expect(
		runCase(`env["check_remote_executor"] = lambda proc: None
messages = iter([
 {"id":101,"result":{"turn":{"id":"turn"}}},
 {"method":"thread/environment/disconnected","params":{"threadId":"other-thread","environmentId":"task-vm"}},
 {"method":"thread/environment/disconnected","params":{"threadId":"thread","environmentId":"other-vm"}},
 {"method":"thread/environment/disconnected","params":{"threadId":"thread","environmentId":"task-vm"}},
])
env["read_message"] = lambda proc, timeout: next(messages)
result = env["run_turn"](None, "thread", "model", "prompt")
assert result["status"] == "failed"
assert "executor disconnected" in result["error"]
assert not any(m["method"] == "environment/status" for m in sent)
assert any(m["method"] == "turn/interrupt" for m in sent)`),
	).toBe("ok");
});

it("uses fail-fast status instead of a recovering info request for health checks", () => {
	expect(
		runCase(`env["wait_for_id"] = lambda proc, request_id, timeout: ({"result":{"status":"disconnected"}}, [])
assert env["check_remote_executor"](None) == env["REMOTE_EXECUTOR_LOST"]
assert sent[-1]["method"] == "environment/status"
env["wait_for_id"] = lambda proc, request_id, timeout: ({"result":{"status":"ready"}}, [])
assert env["check_remote_executor"](None) is None`),
	).toBe("ok");
});
