import { describe, expect, it } from "vitest";
import { visibleShellCommand } from "./visible-shell-command";

describe("visibleShellCommand", () => {
	it("unwraps bash -lc and a leading cd so the timeline shows the real command", () => {
		expect(
			visibleShellCommand(
				`/bin/bash -lc 'cd /home/ubuntu/todo-cli && python3 test_todo.py'`,
			),
		).toBe("python3 test_todo.py");
	});

	it("leaves an already-visible command unchanged", () => {
		expect(visibleShellCommand("python3 todo.py list")).toBe(
			"python3 todo.py list",
		);
	});
});
