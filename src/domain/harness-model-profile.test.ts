import { expect, it } from "vitest";
import {
	harnessModelFamily,
	harnessModelToolInstructions,
	reconstructedContextTransition,
} from "./harness-model-profile";

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
		expect(instructions).not.toContain("oldText");
	},
);
