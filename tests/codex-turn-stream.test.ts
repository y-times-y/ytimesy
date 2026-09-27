import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

function runCase(test: string) {
	return execFileSync(
		"python3",
		[
			"-c",
			`import runpy, types
module = runpy.run_path("src/server/adapters/codex/login-daemon.py")
env = module["run_turn"].__globals__
env["apply_display_env"] = lambda: None
env["next_rpc_id"] = lambda: 42
env["send"] = lambda *args: None
env["consume_stop_request"] = lambda: False
clock = [0]
env["time"] = types.SimpleNamespace(time=lambda: clock[0])
progress = []
completed = {"method":"turn/completed", "params":{"threadId":"thread", "turn":{"id":"turn", "status":"completed"}}}
delta = {"method":"item/agentMessage/delta", "params":{"threadId":"thread", "itemId":"item", "delta":"Hello"}}
ack = {"id":42,"result":{"turn":{"id":"turn"}}}
${test}
print("ok")`,
		],
		{ encoding: "utf8", timeout: 5000 },
	).trim();
}

it("publishes progress before the turn-start acknowledgement arrives", () => {
	expect(
		runCase(`messages = iter([delta, ack, completed])
def read(proc, timeout):
    message = next(messages)
    if message is ack:
        assert progress, "progress was buffered until acknowledgement"
    return message
env["read_message"] = read
result = env["run_turn"](None, "thread", "model", "prompt", on_items=lambda items: progress.append(items))
assert result["status"] == "completed"`),
	).toBe("ok");
});

it("keeps observing a turn after three minutes, including quiet periods", () => {
	expect(
		runCase(`messages = iter([ack, None, delta, completed])
def read(proc, timeout):
    clock[0] += 240
    message = next(messages)
    if message is None:
        raise TimeoutError("no event yet")
    return message
env["read_message"] = read
result = env["run_turn"](None, "thread", "model", "prompt", on_items=lambda items: progress.append(items))
assert result["status"] == "completed", result
assert progress`),
	).toBe("ok");
});

it("handles cancellation during startup without consuming completion in another reader", () => {
	expect(
		runCase(`stops = iter([True, False, False])
env["consume_stop_request"] = lambda: next(stops)
sent = []
env["send"] = lambda proc, payload: sent.append(payload)
messages = iter([ack, completed])
env["read_message"] = lambda proc, timeout: next(messages)
result = env["run_turn"](None, "thread", "model", "prompt")
assert any(m["method"] == "turn/interrupt" for m in sent)
assert result["status"] == "completed"`),
	).toBe("ok");
});

it("reports a provider process exit as an explicit failure", () => {
	expect(
		runCase(`def read(proc, timeout):
    raise RuntimeError("codex app-server closed stdout")
env["read_message"] = read
result = env["run_turn"](None, "thread", "model", "prompt")
assert result["status"] == "failed"
assert result["error"] == "codex app-server closed stdout"`),
	).toBe("ok");
});

it("does not finish from another turn's completion", () => {
	expect(
		runCase(`stale = {"method":"turn/completed", "params":{"threadId":"thread", "turn":{"id":"old", "status":"failed"}}}
messages = iter([ack, stale, completed])
env["read_message"] = lambda proc, timeout: next(messages)
result = env["run_turn"](None, "thread", "model", "prompt")
assert result["status"] == "completed"`),
	).toBe("ok");
});
