import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import type { WorkspaceMachines } from "./workspace-machines";

const SESSION_LOCAL_PATHS = [
	"/tmp/ytimesy-api-progress.json",
	"/tmp/ytimesy-agent-task-tool-request.json",
	"/tmp/ytimesy-agent-task-tool-response.json",
	"/tmp/ytimesy-app-server.err",
	"/tmp/ytimesy-auth-status.json",
	"/tmp/ytimesy-claude-auth-code",
	"/tmp/ytimesy-claude-auth-status.json",
	"/tmp/ytimesy-claude-key.env",
	"/tmp/ytimesy-claude-login.log",
	"/tmp/ytimesy-claude-login.pid",
	"/tmp/ytimesy-claude-login.py",
	"/tmp/ytimesy-claude-task-tools.json",
	"/tmp/ytimesy-claude-task-tools.py",
	"/tmp/ytimesy-claude-turn-pty.py",
	"/tmp/ytimesy-claude-turn.err",
	"/tmp/ytimesy-claude-turn.exit",
	"/tmp/ytimesy-claude-turn.out",
	"/tmp/ytimesy-claude-turn.pid",
	"/tmp/ytimesy-codex-login.hash",
	"/tmp/ytimesy-codex-login.log",
	"/tmp/ytimesy-codex-login.pid",
	"/tmp/ytimesy-codex-login.py",
	"/tmp/ytimesy-codex-thread-state.json",
	"/tmp/ytimesy-codex-external-tokens.json",
	"/tmp/ytimesy-codex-refresh-request.json",
	"/tmp/ytimesy-codex-refresh-response.json",
	"/tmp/ytimesy-side-request.json",
	"/tmp/ytimesy-side-result.json",
	"/tmp/ytimesy-stop-request.json",
	"/tmp/ytimesy-task-request.json",
	"/tmp/ytimesy-task-result.json",
] as const;

const unscopedMachines = new WeakMap<WorkspaceMachines, WorkspaceMachines>();

function baseWorkspaceMachines(machines: WorkspaceMachines): WorkspaceMachines {
	return unscopedMachines.get(machines) ?? machines;
}

export function sessionRuntimeRoot(sessionId: string) {
	const safeId = sessionId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
	return `/tmp/ytimesy-sessions/${safeId || "session"}`;
}

export function scopeSessionRuntimeText(text: string, sessionId: string) {
	const root = sessionRuntimeRoot(sessionId);
	let scoped = text;
	for (const path of SESSION_LOCAL_PATHS) {
		scoped = scoped.replaceAll(path, `${root}/${path.slice("/tmp/".length)}`);
	}
	return scoped;
}

/**
 * Gives two agent conversations independent runtime state while their tool
 * calls intentionally target the same machine and checkout.
 */
export function sessionScopedWorkspaceMachines(
	machines: WorkspaceMachines,
	sessionId: string,
): WorkspaceMachines {
	const base = baseWorkspaceMachines(machines);
	const root = sessionRuntimeRoot(sessionId);
	const prepare = (command: string) =>
		`mkdir -p '${root}'\n${scopeSessionRuntimeText(command, sessionId)}`;
	const scoped: WorkspaceMachines = {
		...base,
		exec: (workspaceId, command, timeoutMs) =>
			base.exec(workspaceId, prepare(command), timeoutMs),
		writeTextFile: async (workspaceId, path, contents) => {
			await base.exec(workspaceId, `mkdir -p '${root}'`, 15_000);
			await base.writeTextFile(
				workspaceId,
				scopeSessionRuntimeText(path, sessionId),
				scopeSessionRuntimeText(contents, sessionId),
			);
		},
		readTextFile: (workspaceId, path) =>
			base.readTextFile(workspaceId, scopeSessionRuntimeText(path, sessionId)),
	};
	unscopedMachines.set(scoped, base);
	return scoped;
}

export function machinesForAgentSession(
	machines: WorkspaceMachines,
	session: Pick<AgentSessionRecord, "id" | "taskPlacement">,
) {
	return session.taskPlacement === "shared"
		? sessionScopedWorkspaceMachines(machines, session.id)
		: baseWorkspaceMachines(machines);
}
