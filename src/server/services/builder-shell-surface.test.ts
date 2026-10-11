import { tool } from "ai";
import { expect, it } from "vitest";
import { z } from "zod";
import { harnessModelToolInstructions } from "#/domain/harness-model-profile";
import { builderShellTools } from "./builder-shell-surface";

it("keeps only the validated shell surface, which selects the shell prompt profile", () => {
	const make = () =>
		tool({ inputSchema: z.object({}), execute: async () => ({}) });
	const names = [
		"execute_command",
		"continue_command",
		"stop_command",
		"apply_patch",
		"read_repository_guidance",
		"report_task_blocked",
		"run_checks",
		"apply_patches",
		"inspect_changes",
		"update_plan",
		"batch_read",
		"search_tools",
	];
	const kept = Object.keys(
		builderShellTools(Object.fromEntries(names.map((name) => [name, make()]))),
	);
	expect(kept).toEqual([
		"execute_command",
		"continue_command",
		"stop_command",
		"apply_patch",
		"read_repository_guidance",
		"report_task_blocked",
	]);
	expect(harnessModelToolInstructions("openai", true, kept)).toContain(
		"v12-shell",
	);
});
