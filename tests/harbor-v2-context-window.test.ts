import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { harborBridgeConfig } from "../evals/harbor_v2/config";
import { requireContextWindow } from "../evals/harbor_v2/runtime";

// A model priced for the route but missing from the window table.
vi.mock("../src/domain/model-context-windows", () => ({
	knownModelLimits: () => undefined,
}));

const bedrock = {
	YTIMESY_HARBOR_ROUTE: "bedrock",
	YTIMESY_HARBOR_APPROVED: "bedrock",
	YTIMESY_HARBOR_TOTAL_USD_CAP: "1",
	YTIMESY_HARBOR_TRIAL_USD_CAP: "0.5",
	YTIMESY_HARBOR_SPEND_LEDGER: "/tmp/bedrock-ledger.jsonl",
};

it("refuses a Bedrock model without a checked-in context window at startup", () => {
	expect(() => harborBridgeConfig(bedrock)).toThrow(
		/No context window is known for openai\.gpt-6\.1-sol; add it to src\/domain\/model-context-windows\.ts/,
	);
});

it("fails a trial's runtime with an unknown window instead of guessing one", () => {
	const model = new MockLanguageModelV4();
	expect(() => requireContextWindow({ model }, "gpt-unlisted")).toThrow(
		/context window of gpt-unlisted is unknown/,
	);
	const known = { model, contextWindow: 1_050_000 };
	expect(requireContextWindow(known, "gpt-6-astra")).toBe(known);
});
