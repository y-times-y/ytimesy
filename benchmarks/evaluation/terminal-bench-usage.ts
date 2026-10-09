import { sessionItemsFromUnknown } from "../../src/domain/session-item";

/** A turn stores cumulative usage; count only its last usage record, once. */
export function terminalBenchUsage(
	turns: readonly { id: string; items: unknown }[],
) {
	let input = 0,
		output = 0,
		cached = 0;
	const seen = new Set<string>();
	for (const turn of turns) {
		if (seen.has(turn.id)) throw new Error("Duplicate evaluation turn.");
		seen.add(turn.id);
		const record = sessionItemsFromUnknown(turn.items)
			.filter((item) => item.kind === "userMessage")
			.at(-1);
		if (record?.kind !== "userMessage" || !record.apiUsage)
			throw new Error("Evaluation token usage is missing.");
		if (
			record.apiUsage.inputTokens === null ||
			record.apiUsage.outputTokens === null ||
			record.apiUsage.cacheReadTokens === null
		)
			throw new Error("Evaluation token usage is incomplete.");
		input += record.apiUsage.inputTokens;
		output += record.apiUsage.outputTokens;
		cached += record.apiUsage.cacheReadTokens ?? 0;
	}
	return {
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cached,
		totalTokens: input + output,
		turns: seen.size,
	};
}
