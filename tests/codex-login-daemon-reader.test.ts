import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

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
