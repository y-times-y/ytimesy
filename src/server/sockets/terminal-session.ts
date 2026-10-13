import { publicFailureMessage } from "#/domain/project-workspace";
import {
	clampPtySize,
	parseTerminalClientMessage,
} from "#/domain/workspace-terminal";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import { requireUser } from "../auth/auth";
import { connectWorkspaceTerminal } from "../services/workspace-terminal";
import type { ClientSocket } from "./client-socket";

export const TERMINAL_PATH = "/api/terminal";

/** Authenticates, opens the workspace PTY and relays it; resolves once connected. */
export async function runTerminalSession(
	socket: ClientSocket,
	headers: Headers,
	url: URL,
) {
	try {
		const user = await requireUser(headers);
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
				if (socket.open) socket.send(data);
			},
			onError: (cause) => {
				sendTerminalError(socket, publicFailureMessage(cause));
			},
		});
		socket.onMessage((data, binary) => {
			if (!binary && typeof data === "string") {
				const control = parseTerminalClientMessage(data);
				if (control) {
					pty.resize({ cols: control.cols, rows: control.rows });
					return;
				}
				pty.write(data);
				return;
			}
			pty.write(data);
		});
		socket.onClose(() => pty.detach());
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

function sendTerminalError(socket: ClientSocket, message: string) {
	if (!socket.open) return;
	try {
		socket.send(JSON.stringify({ type: "error", message }));
	} catch {
		// The browser already dropped the socket.
	}
}
