import { z } from "zod";
import {
	LIVE_PROGRESS_PATH,
	LIVE_SOCKET_CLOSE,
} from "#/domain/live-progress-socket";
import { closedSocketResponse } from "#/realtime/socket-upgrade";
import { openConversationLiveSocket } from "../adapters/realtime-delivery";
import { requireUser } from "../auth/auth";
import { watchableChatSnapshot } from "../services/session-progress";
import {
	SOCKET_ORIGIN_REFUSED,
	socketOriginAllowed,
	trustedSocketOrigins,
} from "./socket-origin";

const selection = z.object({
	projectId: z.string().uuid(),
	sessionId: z.string().uuid(),
});

/**
 * Off unless set: until then every browser stays on the event stream.
 * YTIMESY_LIVE_WS=1 offers it to everyone; YTIMESY_LIVE_WS_USERS (comma
 * separated user ids) to those users only, for a staged rollout.
 */
export function liveProgressSocketEnabled(userId?: string) {
	if (process.env.YTIMESY_LIVE_WS === "1") return true;
	if (!userId) return false;
	return (process.env.YTIMESY_LIVE_WS_USERS ?? "")
		.split(",")
		.map((id) => id.trim())
		.includes(userId);
}

/**
 * The open chat's live progress socket. The web Worker checks who may watch
 * the chat (the same rule as /api/agent/progress) and hands the upgrade to
 * the chat's Durable Object, which holds the socket while it sleeps.
 */
export async function handleLiveProgressSocket(
	request: Request,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== LIVE_PROGRESS_PATH) return null;
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return new Response(null, { status: 426 });
	if (
		!socketOriginAllowed(request.headers.get("origin"), trustedSocketOrigins())
	)
		return new Response(SOCKET_ORIGIN_REFUSED, { status: 403 });
	const notOffered = () =>
		closedSocketResponse(LIVE_SOCKET_CLOSE.notOffered, "use the event stream");
	try {
		const user = await requireUser(request.headers);
		if (!liveProgressSocketEnabled(user.id)) return notOffered();
		const scope = selection.parse(Object.fromEntries(url.searchParams));
		const snapshot = await watchableChatSnapshot({
			...scope,
			userId: user.id,
		});
		if (!snapshot) return new Response(null, { status: 404 });
		return (await openConversationLiveSocket(snapshot)) ?? notOffered();
	} catch (error) {
		if (error instanceof Response) return error;
		return new Response(null, {
			status: error instanceof z.ZodError ? 400 : 503,
		});
	}
}
