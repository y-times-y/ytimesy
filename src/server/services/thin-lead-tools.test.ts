import { type ToolSet, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	leadInspectionRefusal,
	THIN_LEAD_OUTPUT_CHARS,
	thinLeadTools,
} from "./thin-lead-tools";

const stub = (name: string) =>
	tool({
		description: name,
		inputSchema: z.object({
			command: z.string().optional(),
			cmd: z.string().optional(),
			path: z.string().optional(),
			background: z.boolean().optional(),
		}),
		execute: async (input) => `ran ${name} ${JSON.stringify(input)}`,
	});

const surface = (names: readonly string[]): ToolSet =>
	Object.fromEntries(names.map((name) => [name, stub(name)]));

const options = { toolCallId: "t", messages: [], context: {} } as never;

describe("thin fusion lead tools", () => {
	it("keeps delegation, a capped read and an inspection command; drops edits, stdin, run_code and the rest", () => {
		const core = thinLeadTools(
			surface([
				"bash",
				"read",
				"write",
				"edit",
				"run_code",
				"agent",
				"agent_send",
				"web_search",
				"browser_open",
				"report_task_blocked",
			]),
		);
		expect(Object.keys(core).sort()).toEqual([
			"agent",
			"agent_send",
			"bash",
			"read",
			"report_task_blocked",
		]);
		const codex = thinLeadTools(
			surface([
				"exec_command",
				"write_stdin",
				"apply_patch",
				"view_image",
				"agent",
				"agent_send",
			]),
		);
		expect(Object.keys(codex).sort()).toEqual([
			"agent",
			"agent_send",
			"exec_command",
		]);
		expect(core.bash?.description).toContain("Read-only inspection");
	});

	it("runs inspections and refuses anything that builds, writes or runs programs", async () => {
		const tools = thinLeadTools(surface(["bash", "exec_command", "agent"]));
		const run = (name: string, input: Record<string, unknown>) =>
			(async () => tools[name]?.execute?.(input as never, options))();
		await expect(
			run("bash", { command: "git diff --stat" }),
		).resolves.toContain("ran bash");
		await expect(
			run("exec_command", { cmd: "git -C /app diff -- src | head -200" }),
		).resolves.toContain("ran exec_command");
		await expect(
			run("bash", { command: "python3 solution.py" }),
		).rejects.toThrow(
			/Refused: `python3` is not an inspection command.*agent_send/,
		);
		await expect(
			run("bash", { command: "git status", background: true }),
		).rejects.toThrow("background commands are not available");
		await expect(run("exec_command", { cmd: "pytest -q" })).rejects.toThrow(
			"not an inspection command",
		);
	});

	it("allows read-only pipelines and refuses writes, substitution and side doors", () => {
		for (const ok of [
			"git status --short",
			"git diff --stat && git diff -- app.py | head -100",
			"cd sub && ls -la",
			"sed -n '1,80p' src/app.py",
			"grep -rn 'def main' src | head",
			"wc -l a.py b.py",
			'grep -n "a|b" x.py',
			"git log --oneline -5",
		])
			expect(leadInspectionRefusal(ok), ok).toBeNull();
		for (const [bad, why] of [
			["echo hi > f.txt", "redirection"],
			["cat $(ls)", "substitution"],
			["ls; rm -rf x", "&& or |"],
			["sleep 9 &", "background"],
			["sed -i 's/a/b/' f", "could change files"],
			["find . -delete", "could change files"],
			["sort -o out.txt in.txt", "could change files"],
			["git checkout -- f", "not an inspection"],
			["git -c core.pager=sh diff", "could change files"],
			["git diff --output=x", "could change files"],
			["make test", "not an inspection command"],
			["FOO=1 ls", "environment"],
			["sed 's/a/b/' f", "sed -n"],
		])
			expect(leadInspectionRefusal(bad), bad).toContain(why);
	});

	it("caps what an inspection shows the lead", async () => {
		const tools = thinLeadTools({
			bash: tool({
				inputSchema: z.object({ command: z.string() }),
				execute: async () => "x".repeat(THIN_LEAD_OUTPUT_CHARS * 3),
			}),
		});
		const output = await tools.bash?.execute?.(
			{ command: "git diff" } as never,
			options,
		);
		const shown = await tools.bash?.toModelOutput?.({
			toolCallId: "t",
			input: { command: "git diff" },
			output,
		} as never);
		expect(JSON.stringify(shown).length).toBeLessThan(
			THIN_LEAD_OUTPUT_CHARS + 500,
		);
	});
});
