import { expect, it } from "vitest";
import { ANTHROPIC_THINKING_BINDING } from "./anthropic-thinking-binding";

it("never errors on a thinking block made under another system prompt", () => {
	expect(ANTHROPIC_THINKING_BINDING.blockBinding.prefixMismatchBehavior).toBe(
		"drop_block",
	);
});

import { thinkingBindingApplies } from "./anthropic-thinking-binding";

it("applies to every direct Anthropic connection, whether or not the model catalog answered with compaction support", () => {
	expect(
		thinkingBindingApplies({
			provider: "anthropic",
			origin: "https://api.anthropic.com",
		}),
	).toBe(true);
});

it("does not apply to other providers or other endpoints", () => {
	expect(
		thinkingBindingApplies({
			provider: "openai",
			origin: "https://api.openai.com",
		}),
	).toBe(false);
	expect(
		thinkingBindingApplies({
			provider: "anthropic",
			origin: "https://openrouter.ai",
		}),
	).toBe(false);
	expect(
		thinkingBindingApplies({
			provider: "compatible",
			origin: "https://api.anthropic.com",
		}),
	).toBe(false);
});
