export function projectEnvironmentSnapshotSlug(workspaceId: string) {
	return `ytimesy-pe-${compactId(workspaceId)}`;
}

export function agentSessionMachineSlug(sessionId: string) {
	return `ytimesy-ag-${compactId(sessionId)}`;
}

export type SessionMachinePlan =
	| { readonly kind: "resume"; readonly providerRef: string }
	| { readonly kind: "copy-snapshot"; readonly snapshotId: string }
	| { readonly kind: "attach-legacy"; readonly providerRef: string }
	| { readonly kind: "needs-snapshot"; readonly providerRef: string }
	| { readonly kind: "blocked"; readonly reason: string };

/**
 * A project environment is the prepared template. Agents never edit it.
 * New sessions copy from its snapshot. The first live VM on a workspace that
 * was already running agents before snapshots existed stays attached once.
 */
export function sessionMachinePlan(input: {
	readonly sessionProviderRef: string | null;
	readonly templateSnapshotId: string | null;
	readonly templateProviderRef: string | null;
	readonly templateAlreadyBound: boolean;
}): SessionMachinePlan {
	if (input.sessionProviderRef)
		return { kind: "resume", providerRef: input.sessionProviderRef };
	if (input.templateSnapshotId)
		return { kind: "copy-snapshot", snapshotId: input.templateSnapshotId };
	if (input.templateProviderRef && !input.templateAlreadyBound)
		return { kind: "attach-legacy", providerRef: input.templateProviderRef };
	if (input.templateProviderRef)
		return { kind: "needs-snapshot", providerRef: input.templateProviderRef };
	return {
		kind: "blocked",
		reason: "Prepare a project environment before starting an agent.",
	};
}

export function chatsFromAgentSessions(
	sessions: readonly {
		readonly id: string;
		readonly title: string;
		readonly parentSessionId?: string | null;
	}[],
) {
	return sessions
		.filter((session) => !session.parentSessionId)
		.map((session) => ({
			id: session.id,
			title: session.title,
		}));
}

export const COPIED_OPENCODE_STATUS_PATH = "/tmp/ytimesy-opencode-status.json";
export const COPIED_CLAUDE_STATUS_PATH = "/tmp/ytimesy-claude-auth-status.json";

export const COPIED_SESSION_SCRATCH_PATHS = [
	COPIED_OPENCODE_STATUS_PATH,
	COPIED_CLAUDE_STATUS_PATH,
	"/tmp/ytimesy-opencode-serve.pid",
	"/tmp/ytimesy-opencode-serve.log",
	"/tmp/ytimesy-opencode-http-body",
	"/tmp/ytimesy-opencode-auth.json",
	"/tmp/ytimesy-opencode-auth-result.txt",
	"/tmp/ytimesy-auth-status.json",
	"/tmp/ytimesy-task-request.json",
	"/tmp/ytimesy-task-result.json",
	"/tmp/ytimesy-side-request.json",
	"/tmp/ytimesy-side-result.json",
	"/tmp/ytimesy-project-context.md",
] as const;

export const COPIED_SESSION_STATUS_RESETS = [
	{
		path: COPIED_OPENCODE_STATUS_PATH,
		contents: `${JSON.stringify({ stage: "missing" })}\n`,
	},
	{
		path: COPIED_CLAUDE_STATUS_PATH,
		contents: `${JSON.stringify({ stage: "missing" })}\n`,
	},
] as const;

export const COPIED_SESSION_DB_FILES = [
	"/home/ubuntu/.local/share/opencode/opencode.db",
	"/home/ubuntu/.local/share/opencode/opencode.db-wal",
	"/home/ubuntu/.local/share/opencode/opencode.db-shm",
	"/root/.local/share/opencode/opencode.db",
	"/root/.local/share/opencode/opencode.db-wal",
	"/root/.local/share/opencode/opencode.db-shm",
] as const;

export const COPIED_SESSION_SCRATCH_TREES = [
	"/home/ubuntu/.local/share/opencode/log",
	"/home/ubuntu/.local/state/opencode",
	"/home/ubuntu/.codex/sessions",
	"/root/.local/share/opencode/log",
	"/root/.local/state/opencode",
	"/root/.codex/sessions",
] as const;

export function copiedSessionScratchFileResetCommand() {
	return `rm -f ${COPIED_SESSION_SCRATCH_PATHS.join(" ")}`;
}

export function copiedSessionScratchDatabaseResetCommand() {
	return `rm -f ${COPIED_SESSION_DB_FILES.join(" ")}`;
}

export function copiedSessionScratchTreeResetCommand() {
	return `rm -rf ${COPIED_SESSION_SCRATCH_TREES.join(" ")}`;
}

export function copiedSessionScratchResetCommands() {
	return [
		copiedSessionScratchFileResetCommand(),
		copiedSessionScratchDatabaseResetCommand(),
		copiedSessionScratchTreeResetCommand(),
	] as const;
}

export function sessionMachineRefsToDestroy(input: {
	readonly sessionProviderRef: string | null;
	readonly childProviderRefs?: readonly (string | null)[];
	readonly templateProviderRef: string | null;
}): string[] {
	const refs = [
		input.sessionProviderRef,
		...(input.childProviderRefs ?? []),
	].filter((ref): ref is string => Boolean(ref));
	return [...new Set(refs)].filter((ref) => ref !== input.templateProviderRef);
}

function compactId(value: string) {
	return value.replaceAll("-", "").slice(0, 16);
}
