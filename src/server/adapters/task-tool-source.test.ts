import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentTaskToolDefinitions } from "#/domain/agent-task-definitions";
import { embedTaskToolDefinitions } from "./task-tool-source";

describe("shared task tool definitions", () => {
	for (const provider of ["codex", "claude"]) {
		it(`embeds the same schemas into the ${provider} adapter`, () => {
			const filename =
				provider === "codex" ? "login-daemon.py" : "task-tool-server.py";
			const source = embedTaskToolDefinitions(
				readFileSync(
					new URL(`./${provider}/${filename}`, import.meta.url),
					"utf8",
				),
			);
			const output = execFileSync(
				"python3",
				[
					"-c",
					'import sys,json; scope={"__name__":"test"}; exec(sys.stdin.read(),scope); print(json.dumps(scope["TASK_TOOL_DEFINITIONS"]))',
				],
				{ input: source, encoding: "utf8", timeout: 5000 },
			);
			expect(JSON.parse(output)).toEqual(agentTaskToolDefinitions);
		});
	}
	it("refuses a missing injection marker", () => {
		expect(() => embedTaskToolDefinitions("pass")).toThrow("exactly one");
	});
});
