import { Effect } from "effect";
import {
	SESSION_VIEW_FIELD_KEYS,
	type SessionReadDelta,
	type SessionReadFull,
	type SessionReadToken,
	type SessionViewFields,
} from "#/domain/session-delta";
import type { SessionTurnStatus } from "#/domain/session-item";
import {
	transcriptDeltaForOwner,
	transcriptTokenForOwner,
} from "../adapters/agent-session-delta";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { queuedUserMessageItems } from "../adapters/queued-user-messages";
import type { PublicCodexSession } from "./codex-workspace-session";
import {
	type HarnessSessionScope,
	readHarnessWorkspaceSession,
} from "./harness-workspace-session";
import { publicSessionView } from "./queued-user-messages";
import { sessionDeltaChange } from "./session-delta-change";

/** The open chat's view whole, with the transcript token it is at. */
export async function readSessionFull(
	scope: HarnessSessionScope,
): Promise<SessionReadFull<PublicCodexSession>> {
	// The token is read first: the view is then at least as new as the token,
	// and a delta from the token only repeats what the view already shows.
	// A chat without the revision column (before its migration) has no token,
	// and the browser reads it whole each time.
	const token = scope.sessionId
		? await transcriptTokenForOwner(scope.userId, scope.sessionId).catch(
				() => null,
			)
		: null;
	const view = await publicSessionView(scope);
	let queuedCount = 0;
	for (
		let index = view.items.length - 1;
		index >= 0 && waiting(view.items[index]);
		index--
	)
		queuedCount++;
	return {
		mode: "full",
		view,
		token: token && view.agentSessionId === scope.sessionId ? token : null,
		queuedCount,
	};
}

function waiting(item: PublicCodexSession["items"][number] | undefined) {
	return item?.kind === "userMessage" && item.queued === true;
}

/**
 * What changed in the open chat since the browser's read: a delta when it can
 * be told exactly, else the whole view. The delta carries the transcript from
 * the first changed item on, the waiting messages, and the chat row's own
 * fields; the rest of the view (connection, models, send permission) is not
 * read here, and the browser keeps it until its next whole read.
 */
export async function readSessionSince(
	scope: HarnessSessionScope,
	since: SessionReadToken,
	/** Also read the view's non-transcript fields (connection, models, send permission). */
	withFields = false,
): Promise<SessionReadDelta | SessionReadFull<PublicCodexSession>> {
	const sessionId = scope.sessionId;
	if (!sessionId) return readSessionFull(scope);
	// The queue is read before the transcript: a message that moves from the
	// queue into the transcript between the two reads is then in both.
	const queued = await queuedUserMessageItems(sessionId);
	const reading = withFields ? readViewFields(scope, sessionId) : null;
	reading?.catch(() => {});
	const found = await transcriptDeltaForOwner(scope.userId, sessionId, since);
	if (!found || found.token.rev < since.rev) return readSessionFull(scope);
	if (scope.projectId && found.projectId !== scope.projectId)
		throw new Error("Session is not in this project.");
	const ownHarness = scope.harnessId === "codex" ? "codex" : "api";
	const row = {
		turnStatus: found.turnStatus as SessionTurnStatus,
		workspaceId: found.workspaceId,
		selectedBranch: found.selectedBranch,
		listedModelId:
			found.harness === ownHarness ? (found.listedModelId ?? "") : "",
	};
	const fields = reading ? await reading : null;
	if (reading && !fields) return readSessionFull(scope);
	const extra = fields ? { fields } : {};
	if (found.fromPosition === null)
		return {
			mode: "delta",
			token: found.token,
			row,
			change: null,
			queued,
			...extra,
		};
	const change = sessionDeltaChange(found);
	if (!change) return readSessionFull(scope);
	return { mode: "delta", token: found.token, row, change, queued, ...extra };
}

/**
 * The view built over the chat with an empty transcript, so the connection,
 * models and send permission are read as a whole read reads them while no
 * transcript leaves the database. Null for a chat that is not the user's.
 */
async function readViewFields(
	scope: HarnessSessionScope,
	sessionId: string,
): Promise<SessionViewFields | null> {
	const metadata = await agentSessionMetadataForOwner(scope.userId, sessionId);
	if (!metadata) return null;
	const view = await Effect.runPromise(
		readHarnessWorkspaceSession(scope, { ...metadata, items: [] }),
	);
	const fields: Record<string, unknown> = {};
	for (const key of SESSION_VIEW_FIELD_KEYS)
		if (view[key] !== undefined) fields[key] = view[key];
	return fields as SessionViewFields;
}
