import type { AgentProviderId } from "#/domain/agent-provider";
import {
	applySessionDelta,
	type HeldSessionRead,
	type SessionReadDelta,
	type SessionReadFull,
	type SessionReadToken,
} from "#/domain/session-delta";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";

/**
 * The fields a delta does not carry (connection, models, send permission)
 * are read again at least this often while deltas run, in the same call
 * as the delta and without the transcript.
 */
export const WHOLE_READ_EVERY_MS = 12_000;

/** Chats whose last server view is held for deltas. */
const HELD_CHATS = 6;

type ChatSelection = {
	projectId: string;
	sessionId: string;
	harnessId: AgentProviderId;
};

type DeltaRead = (
	input: ChatSelection & { since?: SessionReadToken },
) => Promise<SessionReadDelta | SessionReadFull<PublicCodexSession>>;

/**
 * Reads the open chat as small deltas over the last server view the browser
 * holds, and whole when a delta cannot be told exactly: nothing held, the
 * the turn changed status, the
 * delta does not anchor in the held items, or the delta read failed. What it
 * returns is what a whole read at that moment would return, except the
 * connection, models and send permission, which are at most that old.
 */
export function createSessionDeltaReader(options: {
	read: DeltaRead;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const held = new Map<string, HeldSessionRead<PublicCodexSession>>();

	function remember(key: string, next: HeldSessionRead<PublicCodexSession>) {
		const current = held.get(key);
		// A slower, older response does not take the place of a newer one.
		if (current && current.token.rev > next.token.rev) return;
		held.delete(key);
		held.set(key, next);
		for (const oldest of held.keys()) {
			if (held.size <= HELD_CHATS) break;
			held.delete(oldest);
		}
	}

	async function whole(key: string, selection: ChatSelection) {
		const result = await options.read(selection);
		if (result.mode !== "full") throw new Error("Expected a whole read.");
		if (result.token)
			remember(key, {
				view: result.view,
				token: result.token,
				queuedCount: result.queuedCount,
				fullAt: now(),
			});
		else held.delete(key);
		return result.view;
	}

	async function read(
		selection: ChatSelection,
		/** A whole view already being read ahead (it carries no token), if any. */
		readAhead?: () => Promise<PublicCodexSession | null>,
	): Promise<PublicCodexSession> {
		const key = `${selection.projectId}|${selection.sessionId}|${selection.harnessId}`;
		const previous = held.get(key);
		if (previous) {
			const refreshFields = now() - previous.fullAt >= WHOLE_READ_EVERY_MS;
			try {
				const result = await options.read({
					...selection,
					since: previous.token,
					...(refreshFields ? { fields: true } : {}),
				});
				if (result.mode === "full") {
					if (result.token)
						remember(key, {
							view: result.view,
							token: result.token,
							queuedCount: result.queuedCount,
							fullAt: now(),
						});
					return result.view;
				}
				const merged = applySessionDelta(
					previous,
					result,
					selection.harnessId === "codex",
				);
				if (merged && merged.view.turnStatus === previous.view.turnStatus) {
					remember(key, {
						view: merged.view,
						token: result.token,
						queuedCount: merged.queuedCount,
						fullAt: refreshFields ? now() : previous.fullAt,
					});
					return merged.view;
				}
			} catch {
				// Read whole below; a failure that persists fails there too.
			}
			return whole(key, selection);
		}
		const ahead = await readAhead?.();
		if (ahead) {
			held.delete(key);
			return ahead;
		}
		return whole(key, selection);
	}

	return { read };
}
