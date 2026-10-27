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
		const message =
			cause instanceof Response && cause.status === 401
				? "Sign in required."
				: publicFailureMessage(cause);
		logRelay("desktop", "failed", { reason: message });
		client.close(4000, message || "Desktop failed to connect.");
	}
}

/** Opens the VM's viewer socket, presenting the server-held credential. */
export type OpenDesktopRemote = (
	url: string,
	headers: { authorization: string },
) => Promise<RemoteSocket>;

async function connectRemote(
	remote: DesktopRemote,
	openRemote: OpenDesktopRemote,
) {
	const base = remote.origin.replace(/^http/i, "ws");
	let lastError: unknown;
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
	throw lastError instanceof Error
		? lastError
		: new Error("Desktop is not ready.");
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
