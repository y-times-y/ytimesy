import { describe, expect, it } from "vitest";
import { modelBaseId, modelDisplayName } from "./model-display";

describe("modelDisplayName", () => {
	it.each([
		["claude-code/claude-sonnet-5-5", "Claude Sonnet 5.5"],
		["claude-opus-5-5", "Claude Opus 5.5"],
		["gpt-6-luna", "GPT 6 Luna"],
		["grok-4.7", "Grok 4.7"],
		["gemini-3-pro", "Gemini 3 Pro"],
		["api/3f1c2a4e-8b7d-4c1e-9f0a-1b2c3d4e5f60/openai%2Fgpt-5", "GPT 5"],
	])("%s reads %s", (id, label) => {
		expect(modelDisplayName(id)).toBe(label);
	});
	it("keeps the model of a provider-qualified id", () => {
		expect(modelBaseId("x-ai/grok-4.7")).toBe("grok-4.7");
	});
});
