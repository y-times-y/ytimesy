import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { publicFailureMessage } from "#/domain/project-workspace";
import { projectForOwner } from "./adapters/projects";
import { requireUser } from "./auth/auth";
import { resolveDesktopRemote } from "./services/workspace-desktop";

export const DESKTOP_PATH = "/api/desktop";

export async function handleDesktopSocket(
	client: WebSocket,
	request: IncomingMessage,
	url: URL,
) {
	try {
		const user = await requireUser(headersFromNode(request));
		const projectId = url.searchParams.get("projectId")?.trim() ?? "";
		if (!projectId) {
			client.close(4000, "Select a project to use the desktop.");
			return;
		}
		const project = await projectForOwner(user.id, projectId);
		if (!project) {
			client.close(4000, "Project is not available.");
			return;
		}
		const origin = await resolveDesktopRemote({
			userId: user.id,
			projectId,
			sessionId: url.searchParams.get("sessionId")?.trim() || undefined,
		});
		if (!origin) {
			client.close(4000, "Desktop is not ready.");
			return;
		}
		const remote = await connectDesktopRemote(origin);
		pipeSockets(client, remote);
	} catch (cause) {
		const message =
			cause instanceof Response
				? cause.status === 401
					? "Sign in required."
					: publicFailureMessage(cause)
				: publicFailureMessage(cause);
		client.close(4000, message || "Desktop failed to connect.");
	}
}

async function connectDesktopRemote(origin: string) {
	const candidates = [
		origin.replace(/^http/i, "ws"),
		`${origin.replace(/^http/i, "ws")}/websockify`,
	];
	let lastError: unknown;
	for (const url of candidates) {
		try {
			return await openRemoteSocket(url);
		} catch (cause) {
			lastError = cause;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Desktop is not ready.");
}

function openRemoteSocket(url: string) {
	return new Promise<WebSocket>((resolve, reject) => {
		const remote = new WebSocket(url, ["binary"]);
		const timer = setTimeout(() => {
			remote.terminate();
			reject(new Error("Desktop is not ready."));
		}, 8_000);
		remote.once("open", () => {
			clearTimeout(timer);
			resolve(remote);
		});
		remote.once("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
	});
}

function pipeSockets(client: WebSocket, remote: WebSocket) {
	const forward = (from: WebSocket, to: WebSocket) => {
		from.on("message", (data, isBinary) => {
			if (to.readyState !== WebSocket.OPEN) return;
			to.send(data, { binary: isBinary });
		});
		from.on("close", () => {
			if (to.readyState === WebSocket.OPEN) to.close();
		});
		from.on("error", () => {
			if (to.readyState === WebSocket.OPEN) to.close();
		});
	};
	forward(client, remote);
	forward(remote, client);
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
