export type TurnExecutor = "node" | "durable-object";

export function configuredTurnExecutor(
	value: string | undefined,
): TurnExecutor {
	if (value === undefined || value === "node") return "node";
	if (value === "durable-object") return value;
	throw new Error("Invalid model turn executor selection.");
}
