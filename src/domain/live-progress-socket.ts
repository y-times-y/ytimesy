import type {
	ConversationDelta,
	ConversationSnapshot,
} from "./conversation-delivery";

/**
 * The open chat's live progress over a hibernatable WebSocket (the chat's
 * Durable Object sleeps between updates), replacing the long-lived
 * `/api/agent/progress` event stream that kept it awake.
 */
export const LIVE_PROGRESS_PATH = "/api/agent/live";

/**
 * Keep-alive text frames. The chat's object answers PING through the
 * runtime's WebSocket auto-response, without waking up.
 */
export const LIVE_SOCKET_PING = "ping";
export const LIVE_SOCKET_PONG = "pong";

/** Close codes the browser acts on (4000-4999 are the application's). */
export const LIVE_SOCKET_CLOSE = {
	/** This server does not offer the socket: use the event stream. */
	notOffered: 4001,
	/** The authorization window ended: reconnect now, which checks it again. */
	reauthorize: 4002,
	/** The chat was deleted. */
	gone: 4410,
} as const;

/** A full initial copy or a delta against the last delivered copy. */
export type LiveProgressMessage = {
	readonly revision: string;
	readonly progress?: unknown;
	readonly delta?: ConversationDelta;
};

export function liveProgressMessage(snapshot: ConversationSnapshot) {
	return JSON.stringify({
		revision: snapshot.revision,
		progress: {
			...snapshot.progress,
			sessionId: snapshot.sessionId,
			window: snapshot.window,
		},
	} satisfies LiveProgressMessage);
}
