import { expect, it } from "vitest";
import { ANTHROPIC_THINKING_BINDING } from "./anthropic-thinking-binding";

it("never errors on a thinking block made under another system prompt", () => {
	expect(ANTHROPIC_THINKING_BINDING.blockBinding.prefixMismatchBehavior).toBe(
		"drop_block",
	);
});
