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

/** Chats whose last server view is held for deltas (the open one and the running ones in the background). */
const HELD_CHATS = 12;

type ChatSelection = {
	projectId: string;
	sessionId: string;
	harnessId: AgentProviderId;
};

type DeltaRead = (
	input: ChatSelection & { since?: SessionReadToken; fields?: boolean },
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

	/** One read per chat at a time: a second caller in the same tick takes the first's answer. */
	const inflight = new Map<string, Promise<PublicCodexSession>>();

	function read(
		selection: ChatSelection,
		/** A whole view already being read ahead (it carries no token), if any. */
		readAhead?: () => Promise<PublicCodexSession | null>,
	): Promise<PublicCodexSession> {
		const key = `${selection.projectId}|${selection.sessionId}|${selection.harnessId}`;
		const running = inflight.get(key);
		if (running) return running;
		const started = readOnce(selection, readAhead).finally(() => {
			if (inflight.get(key) === started) inflight.delete(key);
		});
		inflight.set(key, started);
		return started;
	}

	async function readOnce(
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
				if (merged) {
					const statusChanged =
						merged.view.turnStatus !== previous.view.turnStatus;
					let view = merged.view;
					let queuedCount = merged.queuedCount;
					let token = result.token;
					let fullAt = refreshFields ? now() : previous.fullAt;
					if (statusChanged && !refreshFields) {
						// A turn changed status (what canSend and the connection
						// show may have changed with it): the view fields are read
						// again from the new token, with no transcript. That is a
						// few hundred bytes, where a whole page was 60 KB.
						const fields = await options.read({
							...selection,
							since: token,
							fields: true,
						});
						if (fields.mode !== "delta" || !fields.fields) {
							return whole(key, selection);
						}
						const settled = applySessionDelta(
							{
								view: merged.view,
								token,
								queuedCount,
								fullAt,
							},
							fields,
							selection.harnessId === "codex",
						);
						if (!settled) return whole(key, selection);
						view = settled.view;
						fullAt = now();
						queuedCount = settled.queuedCount;
						token = fields.token;
					}
					remember(key, {
						view,
						token,
						queuedCount,
						fullAt,
					});
					return view;
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
