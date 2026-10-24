import { isRealtimeRoute } from "../../realtime/worker";

/**
 * Which handler of the edge executor's fetch takes a path, in the order it
 * checks them. The rehearsal's in-process edge routes by the same function,
 * so a path that the room's router would swallow (as /turn/start once was,
 * by a /turn/ prefix) fails the rehearsal too.
 */
export function executorIngressRoute(
	path: string,
): "room" | "turn-start" | "jobs-start" | "other" {
	if (isRealtimeRoute(path)) return "room";
	if (path === "/turn/start") return "turn-start";
	if (path === "/jobs/start") return "jobs-start";
	return "other";
}
