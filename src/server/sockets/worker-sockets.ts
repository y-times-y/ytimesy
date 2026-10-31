import { trackInvocationTask } from "../adapters/invocation-tasks";
import type { ClientSocket } from "./client-socket";
import { webSocketCloseReason } from "./close-reason";
import {
	DESKTOP_PATH,
	type OpenDesktopRemote,
	runDesktopSession,
} from "./desktop-session";
import { logRelay } from "./relay-log";
import {
	SOCKET_ORIGIN_REFUSED,
	socketOriginAllowed,
	trustedSocketOrigins,
} from "./socket-origin";
import { runTerminalSession, TERMINAL_PATH } from "./terminal-session";

/** Adapts a Workers WebSocket (already accepted) to the shared session code. */
function workerSocket(socket: WebSocket): ClientSocket {
	// From compatibility date 2026-10-08 a Workers WebSocket hands binary
	// frames over as Blob, which `new Uint8Array(...)` turns into zero bytes:
	// every VNC frame and keystroke arrived empty and both panels sat blank.
	socket.binaryType = "arraybuffer";
	return {
		get open() {
			return socket.readyState === WebSocket.OPEN;
		},
		send: (data) => socket.send(data),
		close: (code, reason) => {
			try {
				socket.close(code, webSocketCloseReason(reason));
			} catch {
				// Already closed, or the runtime rejected the frame: still close it.
				try {
					socket.close(code);
				} catch {}
			}
		},
		onMessage: (listener) =>
			socket.addEventListener("message", (event) =>
				typeof event.data === "string"
					? listener(event.data, false)
					: listener(new Uint8Array(event.data as ArrayBuffer), true),
			),
		onClose: (listener) => {
			socket.addEventListener("close", (event) =>
				listener({ code: event.code, reason: event.reason }),
			);
			socket.addEventListener("error", () => listener({ reason: "error" }));
		},
	};
}

/** How long the VM's viewer may take to answer the upgrade. */
const REMOTE_HANDSHAKE_MS = 8_000;

const openWorkerRemoteSocket: OpenDesktopRemote = async (url, auth) => {
	// Times the handshake only: a fetch signal stays bound to the upgraded
	// socket, so AbortSignal.timeout here cut every desktop off after 8s.
	const handshake = new AbortController();
	const timer = setTimeout(() => handshake.abort(), REMOTE_HANDSHAKE_MS);
	try {
		const response = await fetch(url.replace(/^ws/i, "http"), {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": "binary",
				Authorization: auth.authorization,
			},
			signal: handshake.signal,
		});
		if (!response.webSocket) {
			logRelay("desktop", "upstream-status", { status: response.status });
			await response.body?.cancel();
			throw new Error("Desktop is not ready.");
		}
		response.webSocket.accept();
		return workerSocket(response.webSocket);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Terminal and desktop sockets on Workers. Session setup (auth, database, VM)
 * is tracked so the request's database scope stays open until it is done;
 * the established relay needs no database.
 */
export function handleWorkerSocket(request: Request): Response | null {
	const url = new URL(request.url);
	if (
		request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
		(url.pathname !== TERMINAL_PATH && url.pathname !== DESKTOP_PATH)
	)
		return null;
	if (
		!socketOriginAllowed(request.headers.get("origin"), trustedSocketOrigins())
	)
		return new Response(SOCKET_ORIGIN_REFUSED, { status: 403 });
	const pair = new WebSocketPair();
	const [client, server] = Object.values(pair);
	server.accept();
	const socket = workerSocket(server);
	trackInvocationTask(
		url.pathname === TERMINAL_PATH
			? runTerminalSession(socket, request.headers, url)
			: runDesktopSession(socket, request.headers, url, openWorkerRemoteSocket),
	);
	const protocols = request.headers.get("sec-websocket-protocol") ?? "";
	return new Response(null, {
		status: 101,
		webSocket: client,
		headers: protocols.split(",").some((value) => value.trim() === "binary")
			? { "Sec-WebSocket-Protocol": "binary" }
			: {},
	});
}
