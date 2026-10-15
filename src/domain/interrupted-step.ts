import type { ModelMessage } from "ai";
import type { SessionItem } from "./session-item";

const LISTED_CALLS = 20;

/**
 * Prepares a model step that is being re-run after its Durable Object restarted
 * mid-step (for example during a deploy). The model call is simply repeated, but
 * tools it had started may already have changed the workspace, so they are never
 * replayed automatically: unfinished calls are marked interrupted and the model is
 * told which calls ran so it can inspect the state before repeating any of them.
 * Background commands keep running on the VM across the restart.
 */
export function prepareInterruptedStep(
	messages: ModelMessage[],
	items: readonly SessionItem[],
	turnId: string,
	stepIndex: number,
): { messages: ModelMessage[]; items: SessionItem[] } {
	const stepPrefix = `${turnId}:step-${stepIndex}:`;
	const calls: string[] = [];
	const next = items.map((item): SessionItem => {
		if (!item.id.startsWith(`${turnId}:`)) return item;
		if (item.kind === "agentMessage" && item.streaming)
			return { ...item, streaming: false };
		if (item.kind !== "dynamicToolCall") return item;
		// Earlier steps finished, so any call still in progress belongs to the interrupted one.
		if (item.status === "inProgress") {
			calls.push(`- ${item.tool} ${item.input ?? ""} (outcome unknown)`.trim());
			return {
				...item,
				status: "failed",
				output: "Interrupted by a server restart; outcome unknown.",
			};
		}
		if (item.id.startsWith(stepPrefix))
			calls.push(`- ${item.tool} ${item.input ?? ""} (finished)`.trim());
		return item;
	});
	const listed = calls.slice(0, LISTED_CALLS);
	if (calls.length > listed.length)
		listed.push(`- and ${calls.length - listed.length} more`);
	const notice = [
		"Your previous step was interrupted by a server restart before its results were saved, so it is being run again.",
		listed.length
			? `These tool calls had already started and may have changed the workspace:\n${listed.join("\n")}\nInspect the current state before repeating any of them. Background commands keep running on the VM; resume them by id instead of starting them again.`
			: "No tool calls had started.",
	].join("\n");
	return {
		messages: [...messages, { role: "user", content: notice }],
		items: next,
	};
}
