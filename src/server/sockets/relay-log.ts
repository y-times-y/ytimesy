import type { SocketClose } from "./client-socket";

/**
 * One log line per relay event (upstream connect result, either side's
 * close), so a blank Terminal or Desktop panel can be traced from the server
 * log. Never logs credentials, URLs with secrets, or traffic.
 */
export function logRelay(
	relay: "terminal" | "desktop",
	event: string,
	detail: Record<string, unknown> & Partial<SocketClose> = {},
) {
	console.info(`socket-relay ${JSON.stringify({ relay, event, ...detail })}`);
}
