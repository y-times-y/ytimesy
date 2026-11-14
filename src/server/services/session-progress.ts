import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { conversationSnapshot } from "../adapters/conversation-delivery";
import { serverSessionProgressResponse } from "./server-session-progress";

type ProgressScope = {
	userId: string;
	projectId: string;
	sessionId: string;
};

/** The chat, if this user owns it in this project: who may watch it. */
async function watchableChat(input: ProgressScope) {
	// Only whose chat it is: the stream reads the transcript page itself.
	const session = await agentSessionMetadataForOwner(
		input.userId,
		input.sessionId,
	);
	return session && session.projectId === input.projectId ? session : null;
}

export async function sessionProgressResponse(
	input: ProgressScope & { signal: AbortSignal; deltas?: boolean },
) {
	const session = await watchableChat(input);
	if (!session) return new Response(null, { status: 404 });
	return serverSessionProgressResponse({
		userId: input.userId,
		sessionId: session.id,
		signal: input.signal,
		deltas: input.deltas,
	});
}

/** The snapshot a live viewer's socket starts from; null if they may not watch. */
export async function watchableChatSnapshot(input: ProgressScope) {
	const session = await watchableChat(input);
	return session ? conversationSnapshot(input.userId, session.id) : null;
}
