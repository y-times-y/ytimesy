import { describe, expect, it } from "vitest";
import { OFFERED_API_MODELS } from "./api-model-list";
import { CLAUDE_CODE_MODELS } from "./claude-code-route";
import { listedModelDisplayName } from "./listed-model";
import { knownModelLimits } from "./model-context-windows";
import { canonicalModelId, MODEL_TIERS } from "./model-failover";
import { modelPrice } from "./model-pricing";
import {
	isRetiredModel,
	keepsRetiredChatModel,
	withoutRetiredModels,
} from "./retired-model";
import { composerSendBlock } from "./send-blocked";

describe("isRetiredModel", () => {
	it.each([
		"gpt-5",
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.3-codex-spark",
		"gpt-5-mini",
		"gpt-5-nano",
		"gpt-5-codex",
		"openai/gpt-5",
		"openai/gpt-5.5",
		"openai/gpt-5-mini",
		"openai/gpt-5.1-codex-max",
		"openai/gpt-5:free",
		"api/12345678-1234-4123-8123-123456789012/gpt-5.5",
		"api/12345678-1234-4123-8123-123456789012/openai%2Fgpt-5.5",
		"api/12345678-1234-4123-8123-123456789012/anthropic%2Fclaude-fable-5.1",
		"GPT-5.5",
		"GPT-5.3-Codex-Spark",
		"OpenAI: GPT-5 Mini",
		"claude-fable-5-1",
		"claude-fable-5.1",
		"anthropic/claude-fable-5.1",
		"claude-code/claude-fable-5-1",
		"Claude Fable 5.1",
	])("retires %s", (id) => {
		expect(isRetiredModel(id)).toBe(true);
	});

	it.each([
		"gpt-6",
		"gpt-6.1-sol",
		"openai/gpt-6.1-sol",
		"openai/gpt-6-astra",
		"gpt-6-luna",
		"GPT-6.1 Sol",
		"o3",
		"openai/o4-mini",
		"claude-fable-5-2",
		"anthropic/claude-fable-5.2",
		"Claude Fable 5.2",
		"claude-fable-5-10",
		"claude-mythos-5-2",
		"claude-opus-5-5",
		"anthropic/claude-sonnet-5.5",
		"claude-haiku-5-5",
		"gpt-50",
		"api/12345678-1234-4123-8123-123456789012/openai%2Fgpt-6.1-sol",
		"100%",
		"",
	])("keeps %s", (id) => {
		expect(isRetiredModel(id)).toBe(false);
	});

	it("tolerates a missing value", () => {
		expect(isRetiredModel(undefined)).toBe(false);
		expect(isRetiredModel(null)).toBe(false);
	});

	it("filters by id or label", () => {
		expect(
			withoutRetiredModels([
				{ id: "a", label: "GPT-5.5" },
				{ id: "gpt-5.5", label: "x" },
				{ id: "gpt-6-luna", label: "GPT-6-Luna" },
			]).map((model) => model.id),
		).toEqual(["gpt-6-luna"]);
	});
});

describe("history keeps resolving", () => {
	it("still prices and sizes a chat on a retired model", () => {
		expect(modelPrice("claude-fable-5-1")).not.toBeNull();
		expect(modelPrice("anthropic/claude-fable-5.1")).not.toBeNull();
		expect(knownModelLimits("gpt-5.6-sol")?.contextWindow).toBe(1_050_000);
		expect(knownModelLimits("claude-fable-5.1")?.contextWindow).toBe(1_000_000);
		expect(listedModelDisplayName("claude-fable-5-1")).toBe("Claude Fable 5.1");
		expect(listedModelDisplayName("claude-code/claude-fable-5-1")).toBe(
			"Claude Fable 5.1",
		);
	});

	it("keeps failover equivalence for an already-used retired model", () => {
		expect(
			canonicalModelId(
				{ kind: "subscription", provider: undefined, baseUrl: undefined },
				"claude-fable-5-1",
			),
		).toBe("anthropic/claude-fable-5.1");
	});

	it("still sends a chat's retired model that the picker no longer lists", () => {
		const route = "api/12345678-1234-4123-8123-123456789012/openai%2Fgpt-5.5";
		expect(
			composerSendBlock({
				harnessId: "api",
				modelId: route,
				availableModelIds: [
					"api/12345678-1234-4123-8123-123456789012/openai%2Fgpt-6.1-sol",
				],
			}),
		).toBeNull();
		// A current model that is gone still asks for another one.
		expect(
			composerSendBlock({
				harnessId: "api",
				modelId: "api/x/openai%2Fgpt-6.1-sol",
				availableModelIds: [route],
			})?.action,
		).toBe("model_picker");
	});
});

describe("keepsRetiredChatModel", () => {
	it("keeps only the chat's own retired model", () => {
		expect(keepsRetiredChatModel("gpt-5.5", "gpt-5.5")).toBe(true);
		expect(keepsRetiredChatModel("gpt-5.5", "gpt-6-luna")).toBe(false);
		expect(keepsRetiredChatModel("gpt-6-luna", "gpt-6-luna")).toBe(false);
		expect(keepsRetiredChatModel("", "")).toBe(false);
		expect(keepsRetiredChatModel("gpt-5.5", undefined)).toBe(false);
	});
});

describe("what the lists offer", () => {
	it("keeps retired models out of the API list and the Claude Code list", () => {
		for (const model of OFFERED_API_MODELS) {
			expect(isRetiredModel(model.openRouterId)).toBe(false);
			expect(isRetiredModel(model.directId)).toBe(false);
			expect(isRetiredModel(model.label)).toBe(false);
		}
		expect(OFFERED_API_MODELS.map((model) => model.label)).toContain(
			"Claude Fable 5.2",
		);
		for (const model of CLAUDE_CODE_MODELS)
			expect(isRetiredModel(model.id)).toBe(false);
	});

	it("never offers a retired model as a failover target", () => {
		for (const ids of Object.values(MODEL_TIERS))
			for (const id of ids) expect(isRetiredModel(id)).toBe(false);
	});
});
