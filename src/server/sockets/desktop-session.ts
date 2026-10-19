import { publicFailureMessage } from "#/domain/project-workspace";
import { projectForOwner } from "../adapters/projects";
import { requireUser } from "../auth/auth";
import {
	type DesktopRemote,
	resolveDesktopRemote,
} from "../services/workspace-desktop";
import type { ClientSocket, RemoteSocket } from "./client-socket";

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
		const remote = await resolveDesktopRemote({
			userId: user.id,
			projectId,
			sessionId: url.searchParams.get("sessionId")?.trim() || undefined,
		});
		if (!remote) {
			client.close(4000, "Desktop is not ready.");
			return;
		}
		pipe(client, await connectRemote(remote, openRemote));
	} catch (cause) {
		const message =
			cause instanceof Response && cause.status === 401
				? "Sign in required."
				: publicFailureMessage(cause);
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
	for (const url of [base, `${base}/websockify`]) {
		try {
			return await openRemote(url, { authorization: remote.authorization });
		} catch (cause) {
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
	client.onClose(() => remote.close());
	remote.onClose(() => client.close());
}
