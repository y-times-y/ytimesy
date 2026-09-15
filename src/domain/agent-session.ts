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
	}[],
) {
	return sessions.map((session) => ({
		id: session.id,
		title: session.title,
	}));
}

function compactId(value: string) {
	return value.replaceAll("-", "").slice(0, 16);
}
