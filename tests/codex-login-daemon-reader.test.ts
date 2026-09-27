import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("requests reasoning summaries and publishes them before completion", () => {
	const script = `import runpy
module = runpy.run_path("src/server/adapters/codex/login-daemon.py")
run = module["run_turn"]
scope = run.__globals__
sent, published = [], []
messages = iter([
    {"method": "item/reasoning/summaryTextDelta", "params": {"threadId": "main", "itemId": "thought", "delta": "Checking the request", "summaryIndex": 0}},
    {"method": "turn/completed", "params": {"threadId": "main", "turn": {"id": "turn", "status": "completed"}}},
])
scope["apply_display_env"] = lambda: None
scope["consume_stop_request"] = lambda: False
scope["send"] = lambda proc, message: sent.append(message)
scope["read_message"] = lambda proc, timeout: next(messages)
run(None, "main", "test-model", "hello", on_items=lambda items: published.append(items))
assert sent[0]["params"].get("summary") == "concise", sent[0]["params"]
assert published[0][0]["summary"] == ["Checking the request"]
print("ok")`;
	expect(
		execFileSync("python3", ["-c", script], {
			encoding: "utf8",
			timeout: 5000,
		}).trim(),
	).toBe("ok");
});

it("keeps context usage isolated between main and side threads", () => {
	const script = `import runpy
module = runpy.run_path("src/server/adapters/codex/login-daemon.py")
capture = module["capture_usage"]
capture({"method": "thread/tokenUsage/updated", "params": {"threadId": "main", "tokenUsage": {"last": {"totalTokens": 100}}}})
capture({"method": "thread/tokenUsage/updated", "params": {"threadId": "side", "tokenUsage": {"last": {"totalTokens": 20}}}})
capture({"method": "account/rateLimits/updated", "params": {"rateLimits": {"primary": {"usedPercent": 25}}}})
assert module["USAGE"]["threads"]["main"]["last"]["totalTokens"] == 100
assert module["USAGE"]["threads"]["side"]["last"]["totalTokens"] == 20
assert module["USAGE"]["rateLimits"]["rateLimits"]["primary"]["usedPercent"] == 25
assert module["USAGE"]["limitsUpdatedAt"] is not None
capture({"method": "item/started", "params": {"threadId": "main", "item": {"type": "contextCompaction", "id": "compact"}}})
assert module["USAGE"]["compacting"]["main"] is True
assert module["USAGE"]["threads"]["main"]["last"]["totalTokens"] == 100
capture({"method": "item/completed", "params": {"threadId": "main", "item": {"type": "contextCompaction", "id": "compact"}}})
assert module["USAGE"]["compacting"]["main"] is False
print("ok")`;
	expect(
		execFileSync("python3", ["-c", script], {
			encoding: "utf8",
			timeout: 5000,
		}).trim(),
	).toBe("ok");
});

it("retains full todo updates in the VM daemon without item IDs", () => {
	const script = `import runpy
module = runpy.run_path("src/server/adapters/codex/login-daemon.py")
items, order = {}, []
for status in ("pending", "completed"):
    module["apply_app_server_notification"](items, order, {"method": "turn/plan/updated", "params": {"turnId": "one", "plan": [{"step": "Test", "status": status}]}})
assert len(order) == 1
assert items[order[0]]["todos"][0]["status"] == "completed"
print("ok")`;
	expect(
		execFileSync("python3", ["-c", script], {
			encoding: "utf8",
			timeout: 5000,
		}).trim(),
	).toBe("ok");
});

it("reads a completion notification already buffered behind an item event", () => {
	const script = `import os, runpy
module = runpy.run_path("src/server/adapters/codex/login-daemon.py")
read_fd, write_fd = os.pipe()
class Process:
    pid = os.getpid()
    stdout = os.fdopen(read_fd, "rb", buffering=0)
process = Process()
os.write(write_fd, b'{"method":"item/completed"}\\n{"method":"turn/completed"}\\n')
first = module["read_message"](process, 1)
second = module["read_message"](process, 1)
assert first["method"] == "item/completed"
assert second["method"] == "turn/completed"
print("ok")`;
	const output = execFileSync("python3", ["-c", script], {
		cwd: process.cwd(),
		encoding: "utf8",
		timeout: 5_000,
	});
	expect(output.trim()).toBe("ok");
});
