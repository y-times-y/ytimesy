/** Explicit transport identity: a deleted API connection must never become subscription billing. */
const prefix = "codex-subscription:v1:";

export function subscriptionTurnRevision(reasoning?: string, fast = false) {
	return prefix + JSON.stringify({ reasoning, fast });
}

export function subscriptionTurnSettings(revision: string) {
	if (!revision.startsWith(prefix)) return null;
	const value = JSON.parse(revision.slice(prefix.length)) as {
		reasoning?: unknown;
		fast?: unknown;
	};
	if (
		(value.reasoning !== undefined && typeof value.reasoning !== "string") ||
		typeof value.fast !== "boolean"
	)
		throw new Error("Invalid subscription turn settings.");
	return { reasoning: value.reasoning as string | undefined, fast: value.fast };
}
