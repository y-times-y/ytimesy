import { LIVE_SOCKET_CLOSE } from "#/domain/live-progress-socket";
import { USER_HUB_PATH, userHubEnabledFor } from "#/domain/user-hub";
import { closedSocketResponse } from "#/realtime/socket-upgrade";
import { openUserHubSocket } from "../adapters/realtime-delivery";
import { requireUser } from "../auth/auth";
import {
	SOCKET_ORIGIN_REFUSED,
	socketOriginAllowed,
	trustedSocketOrigins,
} from "./socket-origin";

/** YTIMESY_USER_HUB_USERS: user ids (comma separated) or `*`; empty, nobody. */
export function userHubEnabled(userId: string | undefined) {
	return userHubEnabledFor(process.env.YTIMESY_USER_HUB_USERS, userId);
}

/**
 * A signed-in tab's hub socket (`/api/user/live`). The web Worker checks the
 * user once and hands the upgrade to their hub on the edge, which holds the
 * socket while it sleeps. A user without the flag gets 404.
 */
export async function handleUserHubSocket(
	request: Request,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== USER_HUB_PATH) return null;
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return new Response(null, { status: 426 });
	if (
		!socketOriginAllowed(request.headers.get("origin"), trustedSocketOrigins())
	)
		return new Response(SOCKET_ORIGIN_REFUSED, { status: 403 });
	try {
		const user = await requireUser(request.headers);
		if (!userHubEnabled(user.id)) return new Response(null, { status: 404 });
		return (
			(await openUserHubSocket(user.id)) ??
			closedSocketResponse(LIVE_SOCKET_CLOSE.notOffered, "poll instead")
		);
	} catch (error) {
		if (error instanceof Response) return error;
		return new Response(null, { status: 503 });
	}
}
