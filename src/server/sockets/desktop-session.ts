import { Effect } from "effect";
import { publicFailureMessage } from "#/domain/project-workspace";
import { FreestyleWorkspaceMachinesLive } from "../adapters/freestyle/live";
import { projectForOwner } from "../adapters/projects";
import { requireUser } from "../auth/auth";
import { WorkspaceMachineService } from "../services/capabilities";
import {
	type DesktopRemote,
	resolveDesktopRemote,
} from "../services/workspace-desktop";
import type { ClientSocket, RemoteSocket } from "./client-socket";
import { logRelay } from "./relay-log";

export const DESKTOP_PATH = "/api/desktop";

/** Authenticates, connects to the VM's VNC proxy and pipes both ways. */
export async function runDesktopSession(
	client: ClientSocket,
	headers: Headers,
	url: URL,
	openRemote: OpenDesktopRemote,
) {
	try {
		const user = await requireUser(headers);
		const projectId = url.searchParams.get("projectId")?.trim() ?? "";
		if (!projectId) {
			client.close(4000, "Select a project to use the desktop.");
			return;
		}
		if (!(await projectForOwner(user.id, projectId))) {
			client.close(4000, "Project is not available.");
			return;
		}
		const remote = await resolveDesktopRemote(
			{
				userId: user.id,
				projectId,
				sessionId: url.searchParams.get("sessionId")?.trim() || undefined,
			},
			await Effect.runPromise(
				WorkspaceMachineService.pipe(
					Effect.provide(FreestyleWorkspaceMachinesLive),
				),
			),
		);
		if (!remote) {
			logRelay("desktop", "no-machine");
			client.close(4000, "Desktop is not ready.");
			return;
		}
		pipe(client, await connectRemote(remote, openRemote));
	} catch (cause) {
		const message = desktopFailureMessage(cause);
		logRelay("desktop", "failed", { reason: message });
		client.close(4000, message || "Desktop failed to connect.");
	}
}

/** Opens the VM's viewer socket, presenting the server-held credential. */
export type OpenDesktopRemote = (
	url: string,
	headers: { authorization: string },
) => Promise<RemoteSocket>;

/**
 * How long the relay keeps trying to reach the viewer: a machine just woken
 * (or a desktop just started) can need longer than one 8-second handshake.
 */
const CONNECT_WINDOW_MS = 45_000;
const CONNECT_RETRY_PAUSE_MS = 2_000;

async function connectRemote(
	remote: DesktopRemote,
	openRemote: OpenDesktopRemote,
) {
	const base = remote.origin.replace(/^http/i, "ws");
	const until = Date.now() + CONNECT_WINDOW_MS;
	let lastError: unknown;
	for (;;) {
		for (const path of ["", "/websockify"]) {
			const started = Date.now();
			try {
				const socket = await openRemote(`${base}${path}`, {
					authorization: remote.authorization,
				});
				logRelay("desktop", "upstream-open", {
					path: path || "/",
					ms: Date.now() - started,
				});
				return socket;
			} catch (cause) {
				logRelay("desktop", "upstream-refused", {
					path: path || "/",
					ms: Date.now() - started,
					reason: cause instanceof Error ? cause.message : String(cause),
				});
				lastError = cause;
			}
		}
		if (Date.now() + CONNECT_RETRY_PAUSE_MS >= until) break;
		await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_PAUSE_MS));
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Desktop is not ready.");
}

/** What the viewer shows when the desktop never answered, instead of the runtime's "The operation was aborted". */
export function desktopFailureMessage(cause: unknown) {
	if (cause instanceof Response && cause.status === 401)
		return "Sign in required.";
	const aborted =
		cause instanceof Error &&
		(cause.name === "AbortError" ||
			cause.name === "TimeoutError" ||
			/operation was aborted/i.test(cause.message));
	if (aborted) return "The desktop is still starting. Reconnect in a moment.";
	return publicFailureMessage(cause);
}

function pipe(client: ClientSocket, remote: RemoteSocket) {
	client.onMessage((data) => {
		if (remote.open) remote.send(data);
	});
	remote.onMessage((data) => {
		if (client.open) client.send(data);
	});
	client.onClose((close) => {
		logRelay("desktop", "client-closed", { ...close });
		remote.close();
	});
	remote.onClose((close) => {
		logRelay("desktop", "upstream-closed", { ...close });
		client.close();
	});
}
