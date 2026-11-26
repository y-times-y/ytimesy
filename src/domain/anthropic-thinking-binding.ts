/**
 * Claude binds each thinking block to the system prompt it was made under.
 * Our prompt changes between turns (a deploy, a Y² crew change), so with
 * "error" every resumed chat whose history holds thinking blocks failed with
 * "Invalid `signature` in `thinking` block ... The `system` prompt differs"
 * (400, shown as "Your model provider turned this request down", 2026-11-26).
 * "drop_block" lets Anthropic drop the stale block and answer.
 */
export const ANTHROPIC_THINKING_BINDING = {
	blockBinding: { prefixMismatchBehavior: "drop_block" },
} as const;
