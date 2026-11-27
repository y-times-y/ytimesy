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

/**
 * Whether a connection takes the binding option: the direct Anthropic API
 * (the SDK then sends the `thinking-binding-controls-2026-08-01` beta that
 * the option needs). It does not depend on the model catalog's compaction
 * flag: a catalog read that timed out once left the option off, and the next
 * prompt change failed every resumed chat with a 400 (2026-11-27).
 */
export function thinkingBindingApplies(connection: {
	readonly provider: string;
	readonly origin: string;
}): boolean {
	return (
		connection.provider === "anthropic" &&
		connection.origin === "https://api.anthropic.com"
	);
}
