import { describe, expect, it } from "vitest";
import { modelRouteId } from "#/domain/model-connection";
import { pickerViewFor } from "./harness-picker";

const grokPlan = {
	id: "11111111-1111-4111-8111-111111111111",
	provider: "compatible",
	baseUrl: "https://api.x.ai/v1",
	subscription: { provider: "xai" },
};
const openrouter = { id: "22222222-2222-4222-8222-222222222222", provider: "openrouter", baseUrl: null };
const xaiKey = {
	id: "33333333-3333-4333-8333-333333333333",
	provider: "compatible",
	baseUrl: "https://api.x.ai/v1",
};

describe("pickerViewFor", () => {
	it("opens on the chosen model's own section, never a mixed list", () => {
		expect(pickerViewFor("codex", "gpt-6.1-sol", [])).toEqual({
			kind: "codex",
		});
		expect(pickerViewFor("api", "claude-code/claude-opus-5-5", [])).toEqual({
			kind: "claude",
		});
		const connections = [grokPlan, openrouter, xaiKey];
		expect(
			pickerViewFor("api", modelRouteId("11111111-1111-4111-8111-111111111111", "grok-4.7"), connections),
		).toEqual({ kind: "grok" });
		expect(
			pickerViewFor("api", modelRouteId("22222222-2222-4222-8222-222222222222", "x-ai/grok-4.7"), connections),
		).toEqual({
			kind: "api",
			author: "x-ai",
		});
		expect(
			pickerViewFor("api", modelRouteId("33333333-3333-4333-8333-333333333333", "grok-4.7"), connections),
		).toEqual({
			kind: "api",
			author: "x-ai",
		});
	});
});
