import {
	LIVE_SOCKET_PING,
	LIVE_SOCKET_PONG,
} from "../domain/live-progress-socket";

/**
 * The Workers runtime's WebSocket pieces, typed narrowly here because the web
 * and executor builds compile against different runtime declarations.
 */
export interface ServerSocket {
	send(message: string): void;
	close(code?: number, reason?: string): void;
	accept(): void;
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
}

type WorkersRuntime = {
	WebSocketPair: new () => { 0: unknown; 1: unknown };
	WebSocketRequestResponsePair: new (
		request: string,
		response: string,
	) => unknown;
};
const runtime = globalThis as unknown as WorkersRuntime;

export function socketPair(): { client: unknown; server: ServerSocket } {
	const pair = new runtime.WebSocketPair();
	return { client: pair[0], server: pair[1] as ServerSocket };
}

export function upgradeResponse(client: unknown): Response {
	return new Response(null, {
		status: 101,
		webSocket: client,
	} as ResponseInit);
}

/** The ping/pong pair a Durable Object answers without waking. */
export function pingAutoResponse(): unknown {
	return new runtime.WebSocketRequestResponsePair(
		LIVE_SOCKET_PING,
		LIVE_SOCKET_PONG,
	);
}

/**
 * Answers an upgrade with a socket that closes at once with `code`: the only
 * way to tell a browser's WebSocket why (it never sees an HTTP status).
 */
export function closedSocketResponse(code: number, reason: string) {
	const { client, server } = socketPair();
	server.accept();
	server.close(code, reason);
	return upgradeResponse(client);
}
