import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { serverSessionProgressResponse } from "./server-session-progress";

export async function sessionProgressResponse(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	signal: AbortSignal;
}) {
	// Only whose chat it is: the stream reads the transcript page itself.
	const session = await agentSessionMetadataForOwner(
		input.userId,
		input.sessionId,
	);
	if (!session || session.projectId !== input.projectId)
		return new Response(null, { status: 404 });
	return serverSessionProgressResponse({
		userId: input.userId,
		sessionId: session.id,
		signal: input.signal,
	});
}
