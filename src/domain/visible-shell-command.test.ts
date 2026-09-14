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

	it("hides heredoc bodies the way Codex shows a one-line shell activity", () => {
		expect(
			visibleShellCommand(
				`mkdir -p /tmp/src && cat > /tmp/src/hero.tsx <<'EOF'\nexport const hero = { title: "ytimesy" };\nEOF`,
			),
		).toBe("mkdir -p /tmp/src && cat > /tmp/src/hero.tsx");
	});
});
