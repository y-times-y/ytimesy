import {
	agentSessionForOwner,
	sideAgentSession,
} from "../adapters/agent-sessions";
import { serverSessionProgressResponse } from "./server-session-progress";

export async function sessionProgressResponse(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	signal: AbortSignal;
	lane?: "main" | "side";
}) {
	const parent = await agentSessionForOwner(input.userId, input.sessionId);
	if (!parent || parent.projectId !== input.projectId)
		return new Response(null, { status: 404 });
	const session =
		input.lane === "side"
			? await sideAgentSession(input.userId, parent.id)
			: parent;
	if (!session || session.projectId !== input.projectId)
		return new Response(null, { status: 404 });
	return serverSessionProgressResponse({
		userId: input.userId,
		sessionId: session.id,
		displaySessionId: input.sessionId,
		signal: input.signal,
	});
}
