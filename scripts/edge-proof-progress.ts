import { z } from "zod";
import { sessionItemsFromUnknown } from "../src/domain/session-item";

/** A marker in the user's prompt is not evidence that the agent finished. */
export function verifiedEdgeProofProgress(value: unknown, nonce: string) {
	const parsed = z
		.object({ turnStatus: z.literal("completed"), items: z.array(z.unknown()) })
		.safeParse(value);
	if (!parsed.success) return false;
	const items = sessionItemsFromUnknown(parsed.data.items);
	return (
		items.some(
			(item) =>
				item.kind === "agentMessage" &&
				item.text.includes(nonce) &&
				item.text.includes("EDGE_TOOL_PROOF_COMPLETE"),
		) &&
		items.some(
			(item) =>
				(item.kind === "dynamicToolCall" || item.kind === "commandExecution") &&
				item.status === "completed" &&
				item.output?.includes(nonce),
		) &&
		items.some((item) => item.kind === "userMessage" && !!item.apiUsage)
	);
}
