import type { QueryClient } from "@tanstack/react-query";
import type { HubConnection } from "./user-hub-store";

/**
 * A visible tab re-reads the project and chat lists this often. No hub signal
 * covers every change to them (new project or thread, rename, needs you), so
 * this is the catch-all. Slow on purpose (Durable Object cost cap): the reads
 * are plain requests, hidden tabs do not run them (refetchIntervalInBackground
 * is off), and a tab coming back reads on focus.
 */
export const SIDEBAR_REVALIDATE_MS = 60_000;

/** A socket that stays down this long shows the calm notice; shorter blips stay silent. */
export const RECONNECT_NOTICE_AFTER_MS = 4_000;

/** After a project is added, its row and its chats (the Super agent) are read again. */
export async function refreshAfterProjectAdded(client: QueryClient) {
	await Promise.all([
		client.invalidateQueries({ queryKey: ["projects"] }),
		client.invalidateQueries({ queryKey: ["agent-sessions"] }),
	]);
}

/** The notice for stale data, or null: never claims a state the page cannot know. */
export function reconnectingNotice(input: {
	readonly connection: HubConnection;
	readonly everOpen: boolean;
	readonly droppedForMs: number;
	readonly online: boolean;
}): string | null {
	if (!input.online) return "Offline. Showing the last state.";
	if (input.connection.open || !input.everOpen) return null;
	return input.droppedForMs >= RECONNECT_NOTICE_AFTER_MS
		? "Reconnecting…"
		: null;
}
