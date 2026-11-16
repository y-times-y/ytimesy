import { USER_HUB_EDGE_PATH, USER_HUB_NOTE_PATH } from "../../domain/user-hub";
import { isRealtimeRoute } from "../../realtime/worker";

/**
 * Which handler of the edge executor's fetch takes a path, in the order it
 * checks them. The rehearsal's in-process edge routes by the same function,
 * so a path that the room's router would swallow (as /turn/start once was,
 * by a /turn/ prefix) fails the rehearsal too.
 */
export function executorIngressRoute(
	path: string,
):
	| "health"
	| "room"
	| "user-hub"
	| "user-note"
	| "turn-start"
	| "jobs-start"
	| "other" {
	if (path === "/health") return "health";
	if (isRealtimeRoute(path)) return "room";
	if (path === USER_HUB_EDGE_PATH) return "user-hub";
	if (path === USER_HUB_NOTE_PATH) return "user-note";
	if (path === "/turn/start") return "turn-start";
	if (path === "/jobs/start") return "jobs-start";
	return "other";
}
