/** Pure checks for the synthetic canary's chat timeline (docs/interruption-monitoring.md). */
import type { SessionItem } from "./session-item";

/** The canary sends at most this often. */
export const CANARY_EVERY_MINUTES = 30;
/** Both answers must be in the chat this long after the send, else the run fails. */
export const CANARY_LATENCY_BOUND_MS = 8 * 60_000;
/** A missing piece must still be missing this long after the bound (one more tick) before it fails the run. */
export const CANARY_RECHECK_MS = 5 * 60_000;

export const canaryTokens = (nonce: string) => ({
	first: `PONG-A-${nonce}`,
	second: `PONG-B-${nonce}`,
});

/** The two prompts: tiny, so a run costs a few dozen tokens. */
export function canaryPrompts(nonce: string) {
	const { first, second } = canaryTokens(nonce);
	return {
		first: `Canary check. Reply with exactly: ${first}`,
		second: `Canary check. Reply with exactly: ${second}`,
	};
}

export type CanaryVerdict =
	| { readonly status: "pass" }
	| { readonly status: "pending" }
	| { readonly status: "fail"; readonly reason: string };

/**
 * pass: both messages present, each answered, in order (A, answer A, B,
 * answer B), no error item. fail: an error item at once, anything else
 * once the latency bound plus one re-check tick has passed since the send. Otherwise pending.
 */
export function canaryVerdict(
	items: readonly SessionItem[],
	input: {
		readonly nonce: string;
		/** Items the chat already held before this run's first send. */
		readonly baselineItems: number;
		readonly elapsedMs: number;
		readonly latencyBoundMs?: number;
	},
): CanaryVerdict {
	const { first, second } = canaryTokens(input.nonce);
	const added = items.slice(input.baselineItems);
	const error = added.find((item) => item.kind === "error");
	if (error?.kind === "error")
		return {
			status: "fail",
			reason: `the chat shows an error item: ${error.message.slice(0, 200)}`,
		};
	// The nonce is unique to this run, so its messages are found anywhere in the
	// chat: a baseline count shifted by compaction or hand-typed messages must
	// not hide them. Only the error check below is limited to items added since.
	const find = (kind: SessionItem["kind"], token: string, from = 0) => {
		const index = items
			.slice(from)
			.findIndex(
				(item) =>
					item.kind === kind && "text" in item && item.text.includes(token),
			);
		return index < 0 ? -1 : index + from;
	};
	const userA = find("userMessage", first);
	const userB = find("userMessage", second);
	const answerA = userA < 0 ? -1 : find("agentMessage", first, userA);
	const answerB = userB < 0 ? -1 : find("agentMessage", second, userB);
	const missing =
		userA < 0
			? "the first message is missing from the timeline"
			: userB < 0
				? "the queued second message is missing from the timeline"
				: answerA < 0
					? "the first message was not answered"
					: answerB < 0
						? "the queued second message was not answered"
						: null;
	if (!missing) {
		if (answerA < answerB) return { status: "pass" };
		return { status: "fail", reason: "the timeline is out of order" };
	}
	const bound = input.latencyBoundMs ?? CANARY_LATENCY_BOUND_MS;
	return input.elapsedMs >= bound + CANARY_RECHECK_MS
		? {
				status: "fail",
				reason: `${missing} ${Math.round(bound / 60_000)} minutes after the send`,
			}
		: { status: "pending" };
}
