import type { ChatWaitingOn } from "./sidebar-chats";
import type { YOverviewThread } from "./y-overview";
import type { CrewRow } from "./y-squared-crew";

/**
 * The live status card pinned at the top of the Y² chat: the project's
 * threads as "Waiting on you / In progress / Done recently". Built from the
 * sidebar's chat rows (already kept live by the user's hub) plus, when the
 * crew was read, each thread's last request and pull request. Elapsed time
 * is computed on the client from `workingSince`: nothing here calls a model
 * or the server.
 */

export const CARD_REQUEST_LIMIT = 120;
/** A thread that settled this long ago is no longer "done recently". */
export const CARD_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Most "done recently" rows shown. */
export const CARD_DONE_LIMIT = 3;

export type CardStatus = "needs-you" | "working" | "done";

export type CardThread = {
	readonly id: string;
	readonly title: string;
	readonly status: CardStatus;
	/** What it waits on from the person; null unless it needs them. */
	readonly waitingOn: ChatWaitingOn | null;
	/** When the running turn started (ms); null unless working. */
	readonly workingSince: number | null;
	/** The person's last request, at most 120 characters. */
	readonly lastRequest: string | null;
	readonly prUrl: string | null;
	readonly updatedAt: number | null;
};

export type YSquaredCard = {
	readonly waiting: readonly CardThread[];
	readonly working: readonly CardThread[];
	readonly done: readonly CardThread[];
};

const parse = (value: string | null | undefined) => {
	const at = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(at) ? at : null;
};

/** The person's request, cut to the card's 120 characters. */
export function cardRequest(text: string | null | undefined) {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	if (!flat) return null;
	return flat.length > CARD_REQUEST_LIMIT
		? `${flat.slice(0, CARD_REQUEST_LIMIT - 1)}…`
		: flat;
}

/** Needs-you threads first, then working, then the few most recently done. */
export function ySquaredCard(input: {
	readonly chats: readonly YOverviewThread[];
	readonly crew?: readonly Pick<
		CrewRow,
		"sessionId" | "lastRequest" | "prUrl"
	>[];
	readonly now: number;
}): YSquaredCard {
	const crew = new Map((input.crew ?? []).map((row) => [row.sessionId, row]));
	const waiting: CardThread[] = [];
	const working: CardThread[] = [];
	const done: CardThread[] = [];
	for (const chat of input.chats) {
		if (chat.role === "y2" || chat.unused) continue;
		const row = crew.get(chat.id);
		const updatedAt = parse(chat.updatedAt);
		const running = chat.turnStatus === "running" || Boolean(chat.workingSince);
		const base = {
			id: chat.id,
			title: chat.title,
			lastRequest: cardRequest(row?.lastRequest),
			prUrl: row?.prUrl ?? null,
			updatedAt,
		};
		if (running)
			working.push({
				...base,
				status: "working",
				waitingOn: null,
				workingSince: parse(chat.workingSince) ?? updatedAt,
			});
		else if (chat.waitingOn)
			waiting.push({
				...base,
				status: "needs-you",
				waitingOn: chat.waitingOn,
				workingSince: null,
			});
		else if (updatedAt !== null && input.now - updatedAt < CARD_DONE_WINDOW_MS)
			done.push({
				...base,
				status: "done",
				waitingOn: null,
				workingSince: null,
			});
	}
	const newest = (a: CardThread, b: CardThread) =>
		(b.updatedAt ?? 0) - (a.updatedAt ?? 0);
	return {
		waiting: waiting.sort(newest),
		// The longest running first: that is the one to worry about.
		working: working.sort(
			(a, b) => (a.workingSince ?? 0) - (b.workingSince ?? 0),
		),
		done: done.sort(newest).slice(0, CARD_DONE_LIMIT),
	};
}

/**
 * "0:42", "8:05", "1:05:09": how long a turn has run, from its start. Pure,
 * so the card's clock ticks on the client with no server traffic.
 */
export function elapsedClock(since: number | null, now: number) {
	if (since === null) return "";
	const seconds = Math.max(0, Math.floor((now - since) / 1000));
	const s = String(seconds % 60).padStart(2, "0");
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}:${s}`;
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${s}`;
}

/**
 * What the card's rows are made of, without time: the crew snapshot is read
 * again only when this changes (a thread started, settled, needs the person),
 * never on a clock.
 */
export function cardSignature(chats: readonly YOverviewThread[]) {
	return chats
		.filter((chat) => chat.role !== "y2" && !chat.unused)
		.map(
			(chat) =>
				`${chat.id}:${chat.turnStatus ?? ""}:${chat.waitingOn ?? ""}:${chat.workingSince ?? ""}`,
		)
		.sort()
		.join("|");
}

/** True when some thread is working: the only time the card's clock ticks. */
export const cardTicks = (card: YSquaredCard) => card.working.length > 0;
