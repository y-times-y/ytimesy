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
		"read_context_archive",
		"search_context_history",
		"run_checks",
		"apply_patches",
		"inspect_changes",
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
		"report_task_blocked",
		"read_context_archive",
		"search_context_history",
	]);
	expect(harnessModelToolInstructions("openai", true, kept)).toContain(
		"v13-shell",
	);
	// Repository instructions are supplied as messages; the tool is never named.
	expect(harnessModelToolInstructions("openai", true, kept)).not.toContain(
		"read_repository_guidance",
	);
});

it("offers a shell surface exactly as given, without compose_tools or search_tools", async () => {
	const { discoverableAgentTools } = await import("./agent-tool-discovery");
	const { composedAgentTools } = await import("./composed-agent-tools");
	const { isShellSurface } = await import("#/domain/harness-model-profile");
	const make = () =>
		tool({ inputSchema: z.object({}), execute: async () => ({}) });
	const shell = { execute_command: make(), apply_patch: make() };
	expect(isShellSurface(Object.keys(shell))).toBe(true);
	expect(Object.keys(discoverableAgentTools(shell))).toEqual([
		"execute_command",
		"apply_patch",
	]);
	const specialist = { execute_command: make(), run_checks: make() };
	expect(isShellSurface(Object.keys(specialist))).toBe(false);
	expect(Object.keys(discoverableAgentTools(specialist))).toContain(
		"search_tools",
	);
	// The loop skips composition for shell surfaces; specialist surfaces still compose.
	expect(
		Object.keys(
			composedAgentTools({
				tools: specialist,
				signal: new AbortController().signal,
				onEvent: async () => {},
			}),
		),
	).toContain("compose_tools");
});

it("lets the product builder do visual QA without leaving the shell surface", async () => {
	const { discoverableAgentTools } = await import("./agent-tool-discovery");
	const { isShellSurface } = await import("#/domain/harness-model-profile");
	const make = () =>
		tool({ inputSchema: z.object({}), execute: async () => ({}) });
	const browser = [
		"browser_open",
		"browser_screenshot",
		"browser_inspect",
		"browser_execute",
	];
	const kept = Object.keys(
		builderShellTools(
			Object.fromEntries(
				["execute_command", "apply_patch", ...browser].map((name) => [
					name,
					make(),
				]),
			),
		),
	);
	expect(kept).toEqual(["execute_command", "apply_patch", ...browser]);
	expect(isShellSurface(kept)).toBe(true);
	const offered = discoverableAgentTools(
		Object.fromEntries(kept.map((name) => [name, make()])),
	);
	expect(Object.keys(offered)).not.toContain("search_tools");
	expect(
		Object.values(offered).every(
			(definition) => !(definition as { deferLoading?: boolean }).deferLoading,
		),
	).toBe(true);
});
