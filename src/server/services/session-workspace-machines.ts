import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import type { WorkspaceMachines } from "./workspace-machines";

const SESSION_LOCAL_PATHS = [
	"/tmp/ytimesy-codex-external-tokens.json",
	"/tmp/ytimesy-codex-refresh-request.json",
	"/tmp/ytimesy-codex-refresh-response.json",
] as const;

const unscopedMachines = new WeakMap<WorkspaceMachines, WorkspaceMachines>();

function baseWorkspaceMachines(machines: WorkspaceMachines): WorkspaceMachines {
	return unscopedMachines.get(machines) ?? machines;
}

export function sessionRuntimeRoot(sessionId: string) {
	const safeId = sessionId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
	return `/tmp/ytimesy-sessions/${safeId || "session"}`;
}

export function scopeSessionRuntimeText(
	text: string,
	sessionId: string,
	root = sessionRuntimeRoot(sessionId),
) {
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
	const invokeCapability = base.runCapability;
	const scoped: WorkspaceMachines = {
		...base,
		...(invokeCapability
			? {
					runCapability: (workspaceId, request, signal) =>
						invokeCapability(
							workspaceId,
							{
								...request,
								source: scopeSessionRuntimeText(request.source, sessionId),
								arguments:
									request.arguments === undefined
										? undefined
										: JSON.parse(
												scopeSessionRuntimeText(
													JSON.stringify(request.arguments),
													sessionId,
												),
											),
							},
							signal,
						),
				}
			: {}),
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
