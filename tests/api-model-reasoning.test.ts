import { expect, it } from "vitest";
import {
	apiModelReasoning,
	availableConnectionModels,
} from "../src/domain/model-connection";

const catalog = [
	"openai/gpt-6.1-sol",
	"openai/gpt-6.1-sol-pro",
	"openai/gpt-6-luna",
	"anthropic/claude-opus-5.5",
].map((id) => ({
	id,
	label: id.split("/")[1],
	author: id.split("/")[0],
	created: 1_790_000_000,
}));

it("hides OpenRouter's -pro listings; reasoning is low to extra high", () => {
	const listed = availableConnectionModels(
		[
			{
				id: "10b5ffce-4c5e-4611-8210-1b8d5a0ad075",
				provider: "openrouter",
				label: "OpenRouter",
				baseUrl: "https://openrouter.ai/api/v1",
				models: [],
				revision: "1",
			},
		],
		catalog,
	);
	expect(listed.map((model) => model.id)).not.toContain(
		"api/10b5ffce-4c5e-4611-8210-1b8d5a0ad075/openai%2Fgpt-6.1-sol-pro",
	);
	const sol = listed.find((model) => model.id.endsWith("openai%2Fgpt-6.1-sol"));
	expect(sol?.reasoning?.levels.map((level) => level.id)).toEqual([
		"low",
		"medium",
		"high",
		"xhigh",
	]);
});

it("offers effort levels the runtime sends, and none for unknown families", () => {
	expect(
		apiModelReasoning("openrouter", "anthropic/claude-opus-5.5")?.levels.map(
			(level) => level.id,
		),
	).toEqual(["low", "medium", "high", "xhigh", "max"]);
	expect(apiModelReasoning("openrouter", "qwen/qwen-4")).toBeNull();
});
