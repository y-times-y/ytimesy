import type { SessionTurnStatus } from "./session-item";

/**
 * One socket per signed-in tab to the user's hub (a Durable Object keyed by
 * user id), which pushes each chat's turn status as it changes, instead of
 * the browser polling every running chat in the background.
 */
export const USER_HUB_PATH = "/api/user/live";
/** The edge executor's signed path that hands the upgrade to the user's hub. */
export const USER_HUB_EDGE_PATH = "/user/live";
/** The edge executor's signed path the web Worker tells a hub what changed on. */
export const USER_HUB_NOTE_PATH = "/user/note";

/** A note from the web Worker: which of the user's topics changed. */
export type HubNote = { readonly userId: string; readonly topics: string[] };

/** A note's body, or null when it is not one (never trusts the topics' shape). */
export function parseHubNote(value: unknown): HubNote | null {
	if (!value || typeof value !== "object") return null;
	const { userId, topics } = value as Record<string, unknown>;
	if (typeof userId !== "string" || !userId || userId.length > 100) return null;
	if (!Array.isArray(topics)) return null;
	const valid = topics.filter(isHubTopic).slice(0, MAX_HUB_NOTE_TOPICS);
	return valid.length ? { userId, topics: valid } : null;
}

/** How often the browser pings; the hub answers without waking. */
export const USER_HUB_PING_MS = 120_000;
/** Nothing heard (not even a pong) for this long: the socket is dead. */
export const USER_HUB_SILENCE_MS = 2 * USER_HUB_PING_MS + 30_000;
/**
 * How long a hub socket's sign-in check holds. The first push after it
 * closes the socket (no timer) and the reconnect checks the user again.
 */
export const USER_HUB_AUTHORIZATION_MS = 10 * 60_000;
/** Most chats one hub remembers; the oldest updates are dropped first. */
export const MAX_HUB_CHATS = 500;
/**
 * Most sockets (tabs) one user's hub holds. A hibernating socket costs
 * nothing while idle, and a person works with many tabs for hours; a slept
 * laptop's socket may linger until it is closed, so at the limit the oldest
 * is replaced (hubSocketsToEvict) rather than the new tab refused.
 */
export const MAX_HUB_SOCKETS = 64;

/**
 * Which sockets (by index) to close so one more fits under `max`: the
 * oldest first, one with no known age before any.
 */
export function hubSocketsToEvict(
	openedAts: readonly (number | null)[],
	max: number,
): number[] {
	const excess = openedAts.length + 1 - max;
	if (excess <= 0) return [];
	return openedAts
		.map((openedAt, index) => ({ openedAt: openedAt ?? -1, index }))
		.sort((a, b) => a.openedAt - b.openedAt)
		.slice(0, excess)
		.map((entry) => entry.index)
		.sort((a, b) => a - b);
}

/**
 * Who gets the hub: `YTIMESY_USER_HUB_USERS` lists user ids (comma
 * separated) or `*` for everyone. Unset or empty: nobody.
 */
export function userHubEnabledFor(
	setting: string | undefined,
	userId: string | undefined,
): boolean {
	if (!userId) return false;
	const entries = (setting ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return entries.includes("*") || entries.includes(userId);
}

export type HubChatState = {
	readonly turnStatus: SessionTurnStatus;
	readonly updatedAt: number;
};
export type HubChats = Readonly<Record<string, HubChatState>>;
export type HubTurnChange = {
	readonly sessionId: string;
	readonly turnStatus: SessionTurnStatus;
	/** When the chat's object saw it; an older change than the stored one is dropped. */
	readonly at: number;
};
export type HubStatusEntries = Readonly<
	Record<string, { readonly turnStatus: SessionTurnStatus }>
>;

/**
 * The map after one change (the same object when the change is older than
 * the stored one), and the entry to push (null when nothing a socket shows
 * changed).
 */
export function applyHubTurnChange(
	chats: HubChats,
	change: HubTurnChange,
): { chats: HubChats; pushed: HubStatusEntries | null } {
	const current = chats[change.sessionId];
	if (current && change.at < current.updatedAt) return { chats, pushed: null };
	const next = {
		...chats,
		[change.sessionId]: { turnStatus: change.turnStatus, updatedAt: change.at },
	};
	const pushed =
		current?.turnStatus === change.turnStatus
			? null
			: { [change.sessionId]: { turnStatus: change.turnStatus } };
	return { chats: next, pushed };
}

/**
 * What the hub shows for a turn that stopped on the chat's object. A
 * cancelled or handed-off turn shows idle: the browser reads the chat for
 * its real state either way.
 */
export function settledHubTurnStatus(
	outcome: "completed" | "failed" | "cancelled" | "unavailable",
): SessionTurnStatus {
	return outcome === "completed" || outcome === "failed" ? outcome : "idle";
}

/** The chats beyond the newest `limit`, to forget. */
export function staleHubChats(
	chats: HubChats,
	limit = MAX_HUB_CHATS,
): string[] {
	const ids = Object.keys(chats);
	if (ids.length <= limit) return [];
	return ids
		.sort((a, b) => chats[b].updatedAt - chats[a].updatedAt)
		.slice(limit);
}

export function hubStatusEntries(chats: HubChats): HubStatusEntries {
	return Object.fromEntries(
		Object.entries(chats).map(([id, chat]) => [
			id,
			{ turnStatus: chat.turnStatus },
		]),
	);
}

/**
 * What else the hub tells a tab changed, besides turn status: each topic
 * maps to when it last changed (a stamp that only grows). A tab reads the
 * matching data once when a topic it shows changes, instead of polling it.
 * Topics name what changed, never what it changed to: the read stays the
 * one source of truth.
 */
export const hubTopic = {
	/** A helper of this chat was opened, started, blocked or settled (agents list). */
	agents: (parentSessionId: string) => `agents:${parentSessionId}`,
	/** A background command of this chat started or exited. */
	commands: (sessionId: string) => `commands:${sessionId}`,
	/** This project's environment: its status, its build, a build step. */
	workspace: (projectId: string) => `workspace:${projectId}`,
	/** This forked chat's machine copy was bound or failed. */
	fork: (sessionId: string) => `fork:${sessionId}`,
	/** A push card of this user was answered or settled (another may now be outdated). */
	push: "push",
	/** One project's chat list changed: a thread created, renamed, archived, started, settled, needs you. */
	sessions: (projectId: string) => `sessions:${projectId}`,
	/** A chat changed and its project is not at hand: every chat list reads again. */
	sessionsAny: "sessions",
	/** The project list changed: added, archived, removed, its Super agent row. */
	projects: "projects",
	/**
	 * A chat's turn status changed. Made by the tab from `chats`, never sent
	 * as a signal, so turn changes and signals are watched alike.
	 */
	chat: (sessionId: string) => `chat:${sessionId}`,
} as const;

/** Most topics one hub remembers; the oldest are dropped first. */
export const MAX_HUB_SIGNALS = 500;
/** At most this many topics per note, and this long each. */
export const MAX_HUB_NOTE_TOPICS = 20;
const HUB_TOPIC = /^[a-z]+(:[A-Za-z0-9_-]{1,100})?$/;

export function isHubTopic(value: unknown): value is string {
	return typeof value === "string" && HUB_TOPIC.test(value);
}

export type HubSignals = Readonly<Record<string, number>>;

/**
 * The signals after topics changed at `now`: each gets a stamp past its
 * last one (two changes in one millisecond still differ), so every change
 * is pushed. Invalid and repeated topics are ignored.
 */
export function applyHubSignals(
	signals: HubSignals,
	topics: readonly string[],
	now: number,
): { signals: HubSignals; pushed: HubSignals } {
	const pushed: Record<string, number> = {};
	for (const topic of topics.slice(0, MAX_HUB_NOTE_TOPICS)) {
		if (!isHubTopic(topic) || topic in pushed) continue;
		pushed[topic] = Math.max(now, (signals[topic] ?? 0) + 1);
	}
	return { signals: { ...signals, ...pushed }, pushed };
}

/** The topics beyond the newest `limit`, to forget. */
export function staleHubSignals(
	signals: HubSignals,
	limit = MAX_HUB_SIGNALS,
): string[] {
	const topics = Object.keys(signals);
	if (topics.length <= limit) return [];
	return topics.sort((a, b) => signals[b] - signals[a]).slice(limit);
}

/**
 * `full` marks the whole map, sent on every (re)connect. `signals` and
 * `build` come only from a hub that has them: a whole map without `signals`
 * is an older hub, and the tab keeps polling what signals would cover.
 * An older tab ignores both.
 */
export type HubStateMessage = {
	readonly type: "state";
	readonly full?: true;
	readonly chats: HubStatusEntries;
	readonly signals?: HubSignals;
	/** The deploy the hub runs (the web Worker's too: one build id per deploy). */
	readonly build?: string;
	/**
	 * The hub's event version: grows by one with every pushed message and is
	 * the current one on a whole map, so a tab that skipped one resyncs.
	 */
	readonly seq?: number;
};

export function hubStateMessage(
	chats: HubStatusEntries,
	full = false,
	extra: { signals?: HubSignals; build?: string; seq?: number } = {},
) {
	return JSON.stringify({
		type: "state",
		...(full ? { full: true as const } : {}),
		chats,
		...(extra.signals ? { signals: extra.signals } : {}),
		...(extra.build ? { build: extra.build } : {}),
		...(extra.seq !== undefined ? { seq: extra.seq } : {}),
	} satisfies HubStateMessage);
}

const TURN_STATUSES: readonly SessionTurnStatus[] = [
	"idle",
	"running",
	"completed",
	"failed",
];

/** A state message from the hub, or null for anything else (a pong, an unknown frame). */
export function parseHubStateMessage(data: unknown): HubStateMessage | null {
	if (typeof data !== "string" || !data.startsWith("{")) return null;
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const message = value as Record<string, unknown>;
	if (message.type !== "state") return null;
	if (!message.chats || typeof message.chats !== "object") return null;
	const chats: Record<string, { turnStatus: SessionTurnStatus }> = {};
	for (const [id, entry] of Object.entries(message.chats)) {
		const status = (entry as { turnStatus?: unknown } | null)?.turnStatus;
		if (TURN_STATUSES.includes(status as SessionTurnStatus))
			chats[id] = { turnStatus: status as SessionTurnStatus };
	}
	let signals: Record<string, number> | undefined;
	if (message.signals && typeof message.signals === "object") {
		signals = {};
		for (const [topic, at] of Object.entries(message.signals))
			if (isHubTopic(topic) && typeof at === "number" && Number.isFinite(at))
				signals[topic] = at;
	}
	const build =
		typeof message.build === "string" &&
		message.build.length > 0 &&
		message.build.length <= 100
			? message.build
			: undefined;
	return {
		type: "state",
		...(message.full === true ? { full: true } : {}),
		chats,
		...(signals ? { signals } : {}),
		...(build ? { build } : {}),
		...(typeof message.seq === "number" && Number.isSafeInteger(message.seq)
			? { seq: message.seq }
			: {}),
	};
}
