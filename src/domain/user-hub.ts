import type { SessionTurnStatus } from "./session-item";

/**
 * One socket per signed-in tab to the user's hub (a Durable Object keyed by
 * user id), which pushes each chat's turn status as it changes, instead of
 * the browser polling every running chat in the background.
 */
export const USER_HUB_PATH = "/api/user/live";
/** The edge executor's signed path that hands the upgrade to the user's hub. */
export const USER_HUB_EDGE_PATH = "/user/live";

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
/** Most sockets (tabs) one user's hub holds. */
export const MAX_HUB_SOCKETS = 16;

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

/** `full` marks the whole map, sent on every (re)connect. */
export type HubStateMessage = {
	readonly type: "state";
	readonly full?: true;
	readonly chats: HubStatusEntries;
};

export function hubStateMessage(chats: HubStatusEntries, full = false) {
	return JSON.stringify({
		type: "state",
		...(full ? { full: true as const } : {}),
		chats,
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
	return {
		type: "state",
		...(message.full === true ? { full: true } : {}),
		chats,
	};
}
