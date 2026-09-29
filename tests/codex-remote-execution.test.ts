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

it("fails before sending a turn when the remote executor is unavailable", () => {
	expect(
		runCase(`env["check_remote_executor"] = lambda proc: "Executor disconnected"
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
