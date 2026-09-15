import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	clampPtySize,
	parseTerminalClientMessage,
} from "#/domain/workspace-terminal";
import { projectForOwner } from "./adapters/projects";
import { repositoryDirectory } from "./adapters/repository-setup";
import { requireUser } from "./auth/auth";
import { connectWorkspaceTerminal } from "./services/workspace-terminal";

const TERMINAL_PATH = "/api/terminal";
const attached = new WeakSet<Server>();

export function attachTerminalUpgrade(httpServer: Server) {
	const bind = () => {
		if (attached.has(httpServer)) return;
		attached.add(httpServer);
		const wss = new WebSocketServer({ noServer: true });
		const existing = httpServer.listeners("upgrade").slice() as Array<
			(request: IncomingMessage, socket: Duplex, head: Buffer) => void
		>;
		httpServer.removeAllListeners("upgrade");
		httpServer.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname !== TERMINAL_PATH) {
				for (const listener of existing) listener(request, socket, head);
				return;
			}
			wss.handleUpgrade(request, socket, head, (ws) => {
				void handleTerminalSocket(ws, request, url);
			});
		});
	};
	if (httpServer.listening) bind();
	else httpServer.once("listening", bind);
}

async function handleTerminalSocket(
	socket: WebSocket,
	request: IncomingMessage,
	url: URL,
) {
	try {
		const user = await requireUser(headersFromNode(request));
		const projectId = url.searchParams.get("projectId")?.trim() ?? "";
		if (!projectId) {
			sendTerminalError(socket, "Select a project to use the terminal.");
			socket.close();
			return;
		}
		const project = await projectForOwner(user.id, projectId);
		if (!project) {
			sendTerminalError(socket, "Project is not available.");
			socket.close();
			return;
		}
		const size = clampPtySize(
			Number(url.searchParams.get("cols")),
			Number(url.searchParams.get("rows")),
		);
		const pty = await connectWorkspaceTerminal({
			userId: user.id,
			projectId,
			sessionId: url.searchParams.get("sessionId")?.trim() || undefined,
			directory: repositoryDirectory(project.fullName),
			cols: size.cols,
			rows: size.rows,
			onData: (data) => {
				if (socket.readyState === WebSocket.OPEN) socket.send(data);
			},
			onError: (cause) => {
				sendTerminalError(socket, publicFailureMessage(cause));
			},
		});
		socket.on("message", (raw, isBinary) => {
			if (!isBinary) {
				const text =
					typeof raw === "string"
						? raw
						: Buffer.isBuffer(raw)
							? raw.toString("utf8")
							: new TextDecoder().decode(raw as ArrayBuffer);
				const control = parseTerminalClientMessage(text);
				if (control) {
					pty.resize({ cols: control.cols, rows: control.rows });
					return;
				}
				pty.write(text);
				return;
			}
			pty.write(toUint8Array(raw));
		});
		socket.on("close", () => {
			pty.detach();
		});
	} catch (cause) {
		const message =
			cause instanceof Response
				? cause.status === 401
					? "Sign in required."
					: await cause.text()
				: publicFailureMessage(cause);
		sendTerminalError(socket, message || "Terminal failed to connect.");
		socket.close();
	}
}

function sendTerminalError(socket: WebSocket, message: string) {
	if (
		socket.readyState === WebSocket.OPEN ||
		socket.readyState === WebSocket.CONNECTING
	) {
		try {
			socket.send(JSON.stringify({ type: "error", message }));
		} catch {
			// The browser already dropped the socket.
		}
	}
}

function headersFromNode(request: IncomingMessage) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else {
			headers.set(key, value);
		}
	}
	return headers;
}

function toUint8Array(raw: WebSocket.RawData) {
	if (raw instanceof Uint8Array) return raw;
	if (Buffer.isBuffer(raw)) return new Uint8Array(raw);
	if (Array.isArray(raw)) return Buffer.concat(raw);
	return new Uint8Array(raw as ArrayBuffer);
}
