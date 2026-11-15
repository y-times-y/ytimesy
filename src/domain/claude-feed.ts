import { z } from "zod";
import { CLAUDE_CODE_PROXY_PREFIX } from "./claude-code-proxy";

/**
 * The Claude Code output feed: the process running `claude` on the VM
 * (src/domain/claude-agent-runner.ts) pushes the lines it prints to the
 * chat's Durable Object over a WebSocket, so the turn's step reads them from
 * the object's own storage instead of polling the VM, and ends when there is
 * nothing to do. The out file on the VM stays the source of truth: without a
 * feed (an old runner, the path refused, a lost socket) the step polls it as
 * before. Offsets are the lines' byte offsets in that file, so the step's
 * cursor means the same in both modes.
 *
 * Runner to object: hello{turnId,run,receivedFrom?}, lines{from,to,entries},
 * beat, exit{status}. Object to runner: ack{receivedTo,mode}, need{from}, stop.
 * Authenticated with the run's grant (the one the MCP route takes), sent as
 * a bearer or, from a WebSocket client that cannot set headers, as the
 * second subprotocol.
 */
export const CLAUDE_CODE_FEED_PATH = `${CLAUDE_CODE_PROXY_PREFIX}/feed`;
/** The subprotocol the runner offers first and the object selects. */
export const CLAUDE_FEED_PROTOCOL = "ytimesy-claude-feed";
/** The tag (with the turn id) of a feed socket in the chat's object. */
export const CLAUDE_FEED_SOCKET_TAG = "claude-feed";

/** Off unless YTIMESY_CLAUDE_FEED=1: no feed url, no route, no feed step. */
export function claudeFeedEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	return env.YTIMESY_CLAUDE_FEED === "1";
}

/** A runner silent this long (it beats every 20 s) is not followed: the step polls. */
export const CLAUDE_FEED_STALE_MS = 60_000;
/** How long the object lets non-urgent lines wait, by mode, before it wakes the turn. */
export const CLAUDE_FEED_LIVE_MS = 1_000;
export const CLAUDE_FEED_QUIET_MS = 10_000;
/** Largest message the object takes from a runner. */
export const CLAUDE_FEED_MAX_MESSAGE = 2 * 1024 * 1024;

export type ClaudeFeedMode = "live" | "quiet";

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runNumber = z.number().int().min(1).max(10_000);

export const claudeFeedMessage = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("hello"),
		turnId: z.uuid(),
		run: runNumber,
		receivedFrom: offset.optional(),
	}),
	z.object({
		type: z.literal("lines"),
		from: offset,
		to: offset,
		entries: z.array(z.tuple([offset, z.string()])).max(10_000),
	}),
	z.object({ type: z.literal("beat") }),
	z.object({
		type: z.literal("exit"),
		status: z.union([z.number().int(), z.string().max(16)]),
	}),
]);
export type ClaudeFeedMessage = z.infer<typeof claudeFeedMessage>;
export type ClaudeFeedBatch = Extract<ClaudeFeedMessage, { type: "lines" }>;

/** The grant a feed upgrade presents: a bearer, else the second subprotocol. */
export function presentedFeedGrant(headers: Headers) {
	const bearer = /^Bearer\s+(\S+)$/i.exec(
		headers.get("authorization") ?? "",
	)?.[1];
	if (bearer) return bearer;
	const protocols = (headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((value) => value.trim());
	return protocols[0] === CLAUDE_FEED_PROTOCOL ? (protocols[1] ?? null) : null;
}

/** A hello is for an older run than the one this turn already follows. */
export function isStaleFeedRun(currentRun: number | null, run: number) {
	return currentRun !== null && run < currentRun;
}

/**
 * What the object does with a batch, given what it already holds for the
 * run: lines are accepted only in order (from == receivedTo); a batch it
 * already has is acknowledged again; a gap or a partial overlap asks for the
 * lines from receivedTo. A malformed batch is refused like a gap.
 */
export type FeedBatchDecision =
	| { readonly kind: "accept"; readonly receivedTo: number }
	| { readonly kind: "duplicate"; readonly receivedTo: number }
	| { readonly kind: "need"; readonly from: number };

export function feedBatchDecision(
	receivedTo: number,
	batch: Pick<ClaudeFeedBatch, "from" | "to" | "entries">,
): FeedBatchDecision {
	if (batch.to <= receivedTo) return { kind: "duplicate", receivedTo };
	if (batch.from !== receivedTo || !wellFormedBatch(batch))
		return { kind: "need", from: receivedTo };
	return { kind: "accept", receivedTo: batch.to };
}

function wellFormedBatch(
	batch: Pick<ClaudeFeedBatch, "from" | "to" | "entries">,
) {
	if (!batch.entries.length) return false;
	let previous = -1;
	for (const [at] of batch.entries) {
		if (at <= previous || at >= batch.to) return false;
		previous = at;
	}
	return batch.entries[0]?.[0] === batch.from;
}

/** Each entry with the offset after it (the next entry's, the last one's `to`). */
export function feedEntriesWithEnds(
	batch: Pick<ClaudeFeedBatch, "to" | "entries">,
) {
	return batch.entries.map(([at, line], index) => ({
		offset: at,
		next: batch.entries[index + 1]?.[0] ?? batch.to,
		line,
	}));
}

/**
 * Lines the turn should see at once rather than at its cadence: the run's
 * start (its session), a tool call (ytimesy shows it running), its result.
 */
export function isUrgentFeedLine(line: string) {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return false;
	}
	if (!message || typeof message !== "object") return false;
	const { type, subtype } = message as { type?: unknown; subtype?: unknown };
	if (type === "result") return true;
	if (type === "system") return subtype === "init";
	if (type !== "assistant") return false;
	const content = (message as { message?: { content?: unknown } }).message
		?.content;
	return (
		Array.isArray(content) &&
		content.some(
			(block) =>
				block && typeof block === "object" && block.type === "tool_use",
		)
	);
}

/**
 * When the object wakes its sleeping turn for lines that arrived: at once
 * for urgent ones (or the run's exit), else once the oldest unread line
 * has waited the mode's cadence; never later than a wake already set.
 */
export function feedWakeAt(input: {
	readonly now: number;
	readonly urgent: boolean;
	readonly mode: ClaudeFeedMode;
	/** When the oldest line the turn has not read arrived. */
	readonly pendingSince: number;
	/** The turn's wake already set, if any. */
	readonly scheduledAt: number | null;
}) {
	const due = input.urgent
		? input.now
		: Math.max(
				input.now,
				input.pendingSince +
					(input.mode === "live" ? CLAUDE_FEED_LIVE_MS : CLAUDE_FEED_QUIET_MS),
			);
	return input.scheduledAt === null ? due : Math.min(due, input.scheduledAt);
}

/** The object's record of one run's feed. */
export type ClaudeFeedState = {
	readonly run: number;
	readonly receivedTo: number;
	readonly consumedTo: number;
	/** When the runner was last heard (0: never, the record only holds a cursor). */
	readonly lastSeen: number;
	readonly exitStatus: string | null;
};

/**
 * Whether a step follows the run's feed or polls its out file: the feed only
 * when this run's runner said hello and is still heard from.
 */
export function claudeStepSource(
	state: ClaudeFeedState | null,
	now: number,
): "feed" | "poll" {
	return state &&
		state.lastSeen > 0 &&
		now - state.lastSeen < CLAUDE_FEED_STALE_MS
		? "feed"
		: "poll";
}
