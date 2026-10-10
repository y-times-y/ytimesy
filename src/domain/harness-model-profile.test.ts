import { expect, it } from "vitest";
import {
	harnessModelFamily,
	harnessModelToolInstructions,
	reconstructedContextTransition,
} from "./harness-model-profile";

it("requests early executable feedback without sacrificing durable regression coverage", () => {
	const instructions = harnessModelToolInstructions("openai", false);
	expect(instructions).toContain("smallest executable reproduction");
	expect(instructions).toContain("before extensive test scaffolding");
	expect(instructions).toContain("persist regression coverage");
	expect(instructions).toContain("immediately check it");
	expect(instructions).toContain("Do not front-load");
	expect(instructions).toContain(
		"persist regression coverage in existing suites",
	);
	expect(instructions).toContain(
		"without a suite, prefer compact reproducible checks",
	);
	expect(instructions).toContain("never weaken tests");
	expect(instructions).toContain("Preserve every required check");
	expect(instructions).toContain("Derive expected behavior from requirements");
	expect(instructions).toContain("not your patch");
	expect(instructions).toContain("Fix one coherent behavior");
	expect(instructions).toContain("before expanding");
	expect(instructions).toContain("never weaken tests or invent semantics");
});

it("does not send a builder searching for absent planning or delegation tools", () => {
	const instructions = harnessModelToolInstructions("openai", false, [
		"execute_command",
		"apply_patch",
		"run_checks",
		"inspect_changes",
		"read_file",
	]);
	expect(instructions).not.toContain("update_plan");
	expect(instructions).not.toContain("read_work_plan");
	expect(instructions).not.toContain("delegation");
	expect(instructions).toContain("Only offered tools");
});

it("preserves offered planning and recommends bounded evidence instead of duplicate full reads", () => {
	const instructions = harnessModelToolInstructions("openai", false, [
		"update_plan",
		"read_work_plan",
	]);
	expect(instructions).toContain("update_plan");
	expect(instructions).toContain("read_work_plan");
	expect(instructions).toContain("outputView:summary");
	expect(instructions).toContain("configured formatter");
	expect(instructions).toContain("never invent line limits");
	expect(instructions).toContain("match existing style");
	expect(instructions).toContain("Do not reread entire");
});

it("keeps the current user request last and explains reconstructed history without forwarding opaque state", () => {
	const current = { role: "user" as const, content: "Continue" };
	const history = [
		{ role: "assistant" as const, content: "Earlier visible result" },
		current,
	];
	const result = reconstructedContextTransition(history, "next-model");
	expect(result.at(-1)).toBe(current);
	expect(result[1].content).toContain("Native continuation was not reused");
	expect(history).toHaveLength(2);
	expect(reconstructedContextTransition([current], "next-model")).toEqual([
		current,
	]);
});

it("resolves routed provider families without treating all compatible endpoints as OpenAI models", () => {
	expect(harnessModelFamily("openrouter.chat", "anthropic/claude-opus")).toBe(
		"anthropic",
	);
	expect(harnessModelFamily("codex-subscription.responses", "gpt-model")).toBe(
		"openai",
	);
	expect(harnessModelFamily("compatible.chat", "gpt-alias")).toBe("other");
	expect(harnessModelFamily("google.generative-ai", "gemini")).toBe("google");
});

it("does not recommend a native tool unless it is actually offered", () => {
	expect(harnessModelToolInstructions("openai", false)).toContain(
		"replace_text",
	);
	expect(harnessModelToolInstructions("openai", true)).toContain(
		"native apply_patch",
	);
	expect(harnessModelToolInstructions("anthropic", false)).toContain(
		"Signed thinking",
	);
});

it.each(["openai", "anthropic", "google", "other"] as const)(
	"bounds unconditional %s guidance without weakening source or verification contracts",
	(family) => {
		const instructions = harnessModelToolInstructions(family, false);
		expect(instructions.length).toBeLessThan(2200);
		expect(instructions).toContain("Read current source");
		expect(instructions).toContain("required bodies completely");
		expect(instructions).toContain("Preserve every required check");
		expect(instructions).toContain("actual exit and stop status");
		expect(instructions).toContain("execute_command with rg");
		expect(instructions).not.toContain("discover replace_text");
		expect(instructions).not.toContain("oldText");
		expect(instructions).toContain("least expensive safe workflow");
		expect(instructions).toContain("when semantic uncertainty warrants");
		expect(instructions).not.toContain("Use rename_symbol, rename_file");
	},
);

it("gives a shell-shaped surface shell guidance without naming tools it was not offered", () => {
	const instructions = harnessModelToolInstructions("openai", true, [
		"execute_command",
		"continue_command",
		"stop_command",
		"apply_patch",
		"view_image",
		"read_repository_guidance",
	]);
	expect(instructions).toContain("v12-shell");
	expect(instructions).toContain("reproduce the problem");
	for (const absent of ["run_checks", "inspect_changes", "compose_tools"])
		expect(instructions).not.toContain(absent);
	expect(
		harnessModelToolInstructions("openai", true, [
			"execute_command",
			"run_checks",
		]),
	).toContain("v8");
});
