export type TurnExecutor = "node" | "durable-object";

export function configuredTurnExecutor(
	value: string | undefined,
): TurnExecutor {
	if (value === undefined || value === "node") return "node";
	if (value === "durable-object") return value;
	throw new Error("Invalid model turn executor selection.");
}

/** The users whose API turns may run on the turn runner boxes (comma separated ids; "*" is everyone). */
export function boxTurnUsers(value: string | undefined): ReadonlySet<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
}

/**
 * Where a new turn runs. The boxes take it only when the deployment runs
 * turns in Durable Objects, the user is enabled for boxes, the turn is an API
 * connection's (not a Codex or Claude subscription's), and a box was seen
 * lately: with none, the turn runs in its chat's object as before, so a
 * down fleet never strands a turn.
 */
export function chooseTurnExecutor(input: {
	readonly configured: TurnExecutor;
	readonly userId: string;
	readonly boxUsers: ReadonlySet<string>;
	readonly eligible: boolean;
	readonly boxAlive: boolean;
}): TurnExecutor {
	if (input.configured !== "durable-object") return input.configured;
	const enabled = input.boxUsers.has("*") || input.boxUsers.has(input.userId);
	return enabled && input.eligible && input.boxAlive
		? "node"
		: input.configured;
}
