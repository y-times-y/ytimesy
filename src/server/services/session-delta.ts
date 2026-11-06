import type {
	SessionReadDelta,
	SessionReadFull,
	SessionReadToken,
} from "#/domain/session-delta";
import type { SessionTurnStatus } from "#/domain/session-item";
import {
	transcriptDeltaForOwner,
	transcriptTokenForOwner,
} from "../adapters/agent-session-delta";
import { queuedUserMessageItems } from "../adapters/queued-user-messages";
import type { PublicCodexSession } from "./codex-workspace-session";
import type { HarnessSessionScope } from "./harness-workspace-session";
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
): Promise<SessionReadDelta | SessionReadFull<PublicCodexSession>> {
	const sessionId = scope.sessionId;
	if (!sessionId) return readSessionFull(scope);
	// The queue is read before the transcript: a message that moves from the
	// queue into the transcript between the two reads is then in both.
	const queued = await queuedUserMessageItems(sessionId);
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
	if (found.fromPosition === null)
		return { mode: "delta", token: found.token, row, change: null, queued };
	const change = sessionDeltaChange(found);
	if (!change) return readSessionFull(scope);
	return { mode: "delta", token: found.token, row, change, queued };
}
