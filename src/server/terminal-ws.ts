import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { DESKTOP_PATH, runDesktopSession } from "./sockets/desktop-session";
import { nodeClientSocket, openNodeRemoteSocket } from "./sockets/node-sockets";
import {
	socketOriginAllowed,
	trustedSocketOrigins,
} from "./sockets/socket-origin";
import { runTerminalSession, TERMINAL_PATH } from "./sockets/terminal-session";

const attached = new WeakSet<Server>();

/** Local Node dev server only; on Workers see sockets/worker-sockets.ts. */
export function attachTerminalUpgrade(httpServer: Server) {
	const bind = () => {
		if (attached.has(httpServer)) return;
		attached.add(httpServer);
		const wss = new WebSocketServer({
			noServer: true,
			handleProtocols: (protocols) =>
				protocols.has("binary") ? "binary" : false,
		});
		const existing = httpServer.listeners("upgrade").slice() as Array<
			(request: IncomingMessage, socket: Duplex, head: Buffer) => void
		>;
		httpServer.removeAllListeners("upgrade");
		httpServer.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname !== DESKTOP_PATH && url.pathname !== TERMINAL_PATH) {
				for (const listener of existing) listener(request, socket, head);
				return;
			}
			const origin = request.headers.origin ?? null;
			if (!socketOriginAllowed(origin, trustedSocketOrigins())) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				return;
			}
			wss.handleUpgrade(request, socket, head, (ws) => {
				const client = nodeClientSocket(ws);
				const headers = headersFromNode(request);
				void (url.pathname === TERMINAL_PATH
					? runTerminalSession(client, headers, url)
					: runDesktopSession(client, headers, url, openNodeRemoteSocket));
			});
		});
	};
	if (httpServer.listening) bind();
	else httpServer.once("listening", bind);
}

function headersFromNode(request: IncomingMessage) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value))
			for (const item of value) headers.append(key, item);
		else headers.set(key, value);
	}
	return headers;
}
