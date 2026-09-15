import type { AgentProviderId } from "#/domain/agent-provider";
import {
	agentSessionMachineSlug,
	COPIED_SESSION_STATUS_RESETS,
	copiedSessionScratchResetCommands,
	projectEnvironmentSnapshotSlug,
	type SessionMachinePlan,
	sessionMachinePlan,
	sessionMachineRefsToDestroy,
	shouldResealProjectSnapshotAfterCopyFailure,
	workspaceCopyCapacityRetryDelaysMs,
} from "#/domain/agent-session";
import { failureMessage } from "#/domain/failure-message";
import { WorkspaceId } from "#/domain/ids";
import { listedModelPreferenceFromSessions } from "#/domain/listed-model";
import {
	PROJECT_CONTEXT_PATH,
	projectContextDocument,
	promptTextWithProjectContext,
	relatedTracesForTask,
} from "#/domain/project-context";
import { workspaceEnvironmentIsReady } from "#/domain/project-workspace";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	childAgentSession,
	childAgentSessions,
	deleteAgentSessionForOwner,
	insertAgentSession,
	listAgentSessions,
	saveAgentSessionProviderRef,
} from "#/server/adapters/agent-sessions";
import {
	listProjectTraces,
	loadProjectBriefing,
} from "#/server/adapters/project-context";
import {
	saveTemplateSnapshot,
	workspaceForProject,
} from "#/server/adapters/workspaces";
import type { WorkspaceMachines } from "./workspace-machines";

async function resolveAgentSessionRecord(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly harness: AgentProviderId;
	readonly sessionId?: string;
	readonly createNew?: boolean;
	readonly parentSessionId?: string;
}) {
	const workspace = await workspaceForProject(input.userId, input.projectId);
	if (!workspace || !workspaceEnvironmentIsReady(workspace)) {
		throw new Error("Prepare a project environment before starting an agent.");
	}
	const sessions = await listAgentSessions(input.userId, input.projectId);
	const selected = input.createNew
		? null
		: input.sessionId
			? ((await agentSessionForOwner(input.userId, input.sessionId)) ??
				sessions.find((session) => session.id === input.sessionId) ??
				null)
			: input.parentSessionId
				? await childAgentSession(input.userId, input.parentSessionId)
				: (sessions[0] ?? null);
	if (input.sessionId && !input.createNew && !selected) {
		throw new Error("Agent session is not available.");
	}
	const parent = input.parentSessionId
		? ((await agentSessionForOwner(input.userId, input.parentSessionId)) ??
			null)
		: null;
	const inherited = listedModelPreferenceFromSessions({
		harness: input.harness,
		sessions: [
			...(parent
				? [
						{
							harness: parent.harness,
							listedModelId: parent.listedModelId,
							items: parent.items,
						},
					]
				: []),
			...sessions.map((session) => ({
				harness: session.harness,
				listedModelId: session.listedModelId,
				items: session.items,
			})),
		],
	});
	const session =
		selected ??
		(await insertAgentSession({
			userId: input.userId,
			projectId: input.projectId,
			workspaceId: workspace.id,
			harness: input.harness,
			parentSessionId: input.parentSessionId,
			title: input.parentSessionId ? "Side chat" : undefined,
			listedModelId: inherited.listedModelId || null,
		}));
	return {
		session,
		workspace: {
			id: workspace.id,
			providerRef: workspace.providerRef,
			templateSnapshotId: workspace.templateSnapshotId,
		},
	};
}

/**
 * New chat is a session row. The VM copy waits until Connect or Send so
 * opening a composer does not consume a Freestyle slot.
 */
export async function openAgentSession(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly harness: AgentProviderId;
	readonly parentSessionId?: string;
}) {
	const { session } = await resolveAgentSessionRecord({
		...input,
		createNew: true,
	});
	return session;
}

export async function bindAgentSessionMachine(
	machines: WorkspaceMachines,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly harness: AgentProviderId;
		readonly sessionId?: string;
		readonly createNew?: boolean;
		readonly parentSessionId?: string;
	},
) {
	const { session, workspace } = await resolveAgentSessionRecord(input);
	const executed = await executeSessionMachinePlan({
		machines,
		sessionId: session.id,
		sessionProviderRef: session.providerRef,
		workspaceId: workspace.id,
		templateSnapshotId: workspace.templateSnapshotId,
		templateProviderRef: workspace.providerRef,
		saveTemplateSnapshot: (snapshotId) =>
			saveTemplateSnapshot(workspace.id, snapshotId).then(() => undefined),
		saveSessionProviderRef: (providerRef) =>
			saveAgentSessionProviderRef(session.id, providerRef).then(
				() => undefined,
			),
	});
	return {
		session: { ...session, providerRef: executed.providerRef },
		providerRef: executed.providerRef,
	};
}

export async function peekAgentSessionMachine(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly sessionId?: string;
}): Promise<{
	session: AgentSessionRecord | null;
	providerRef: string | null;
}> {
	const sessions = await listAgentSessions(input.userId, input.projectId);
	const session = input.sessionId
		? ((await agentSessionForOwner(input.userId, input.sessionId)) ??
			sessions.find((row) => row.id === input.sessionId) ??
			null)
		: (sessions[0] ?? null);
	return { session, providerRef: session?.providerRef ?? null };
}

/**
 * Deletes this agent session and its side-chat copy. The project snapshot and
 * template VM stay. A session that was attached to the template before
 * snapshots existed only drops the row.
 */
export async function deleteAgentSessionMachine(
	machines: Pick<WorkspaceMachines, "destroy">,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly sessionId: string;
	},
) {
	const session = await agentSessionForOwner(input.userId, input.sessionId);
	if (!session || session.projectId !== input.projectId) {
		throw new Error("Agent session is not available.");
	}
	const workspace = await workspaceForProject(input.userId, input.projectId);
	const children = session.parentSessionId
		? []
		: await childAgentSessions(input.userId, session.id);
	const refs = sessionMachineRefsToDestroy({
		sessionProviderRef: session.providerRef,
		childProviderRefs: children.map((child) => child.providerRef),
		templateProviderRef: workspace?.providerRef ?? null,
	});
	for (const ref of refs) {
		await machines.destroy(WorkspaceId(ref));
	}
	await deleteAgentSessionForOwner(input.userId, session.id);
}

export async function executeSessionMachinePlan(input: {
	readonly machines: Pick<
		WorkspaceMachines,
		| "snapshotEnvironment"
		| "provisionSession"
		| "ensureRunning"
		| "exec"
		| "writeTextFile"
	>;
	readonly sessionId: string;
	readonly sessionProviderRef: string | null;
	readonly workspaceId: string;
	readonly templateSnapshotId: string | null;
	readonly templateProviderRef: string | null;
	readonly saveTemplateSnapshot: (snapshotId: string) => Promise<void>;
	readonly saveSessionProviderRef: (providerRef: string) => Promise<void>;
	readonly wait?: (ms: number) => Promise<void>;
}): Promise<{ providerRef: string; planKind: SessionMachinePlan["kind"] }> {
	let snapshotId = input.templateSnapshotId;
	let plan = sessionMachinePlan({
		sessionProviderRef: input.sessionProviderRef,
		templateSnapshotId: snapshotId,
		templateProviderRef: input.templateProviderRef,
	});
	if (plan.kind === "needs-snapshot") {
		await input.machines.ensureRunning(WorkspaceId(plan.providerRef));
		snapshotId = await input.machines.snapshotEnvironment(
			WorkspaceId(plan.providerRef),
			projectEnvironmentSnapshotSlug(input.workspaceId),
		);
		await input.saveTemplateSnapshot(snapshotId);
		plan = sessionMachinePlan({
			sessionProviderRef: input.sessionProviderRef,
			templateSnapshotId: snapshotId,
			templateProviderRef: input.templateProviderRef,
		});
	}
	if (plan.kind === "blocked") throw new Error(plan.reason);
	if (plan.kind === "resume") {
		await input.machines.ensureRunning(WorkspaceId(plan.providerRef));
		if (!input.sessionProviderRef)
			await input.saveSessionProviderRef(plan.providerRef);
		return { providerRef: plan.providerRef, planKind: plan.kind };
	}
	if (plan.kind !== "copy-snapshot") {
		throw new Error("Could not copy the project snapshot.");
	}
	const copied = await copyAgentSessionFromTemplate(input, plan.snapshotId);
	await input.saveSessionProviderRef(copied);
	await resetCopiedSessionScratch(input.machines, copied);
	return { providerRef: copied, planKind: plan.kind };
}

async function copyAgentSessionFromTemplate(
	input: {
		readonly machines: Pick<
			WorkspaceMachines,
			"snapshotEnvironment" | "provisionSession" | "ensureRunning"
		>;
		readonly sessionId: string;
		readonly workspaceId: string;
		readonly templateProviderRef: string | null;
		readonly saveTemplateSnapshot: (snapshotId: string) => Promise<void>;
		readonly wait?: (ms: number) => Promise<void>;
	},
	snapshotId: string,
) {
	const slug = agentSessionMachineSlug(input.sessionId);
	try {
		return await input.machines.provisionSession(slug, snapshotId);
	} catch (cause) {
		const message = failureMessage(cause);
		if (
			shouldResealProjectSnapshotAfterCopyFailure(message) &&
			input.templateProviderRef
		) {
			await input.machines.ensureRunning(
				WorkspaceId(input.templateProviderRef),
			);
			const nextSnapshotId = await input.machines.snapshotEnvironment(
				WorkspaceId(input.templateProviderRef),
				projectEnvironmentSnapshotSlug(input.workspaceId),
			);
			await input.saveTemplateSnapshot(nextSnapshotId);
			return await input.machines.provisionSession(slug, nextSnapshotId);
		}
		return await retryCopyAfterCapacityLag(input.machines, slug, snapshotId, {
			cause,
			wait: input.wait,
		});
	}
}

async function retryCopyAfterCapacityLag(
	machines: Pick<WorkspaceMachines, "provisionSession">,
	slug: string,
	snapshotId: string,
	input: {
		readonly cause: unknown;
		readonly wait?: (ms: number) => Promise<void>;
	},
) {
	const wait =
		input.wait ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, ms);
			}));
	let cause = input.cause;
	for (const delay of workspaceCopyCapacityRetryDelaysMs(
		failureMessage(cause),
	)) {
		await wait(delay);
		try {
			return await machines.provisionSession(slug, snapshotId);
		} catch (retryCause) {
			cause = retryCause;
			if (
				workspaceCopyCapacityRetryDelaysMs(failureMessage(retryCause))
					.length === 0
			) {
				throw retryCause;
			}
		}
	}
	throw cause;
}

/**
 * Guest `rm` of `/tmp` can fail when the snapshot files are root-owned
 * (sticky bit). Freestyle `exec` is not a shell, so reset uses one direct
 * `rm -rf` argv instead of `bash -lc`. Status files are overwritten through
 * the FS API so Connect cannot reload the template chat.
 */
async function resetCopiedSessionScratch(
	machines: Pick<WorkspaceMachines, "exec" | "writeTextFile">,
	copied: WorkspaceId,
) {
	await Promise.all(
		copiedSessionScratchResetCommands().map((command) =>
			machines.exec(copied, command, 15_000),
		),
	);
	await Promise.all(
		COPIED_SESSION_STATUS_RESETS.map((file) =>
			machines.writeTextFile(copied, file.path, file.contents),
		),
	);
}

export async function syncProjectContextForTask(
	machines: Pick<WorkspaceMachines, "writeTextFile">,
	providerRef: string,
	input: { readonly projectId: string; readonly task: string },
): Promise<string> {
	const briefing = await loadProjectBriefing(input.projectId);
	const traces = relatedTracesForTask(
		await listProjectTraces(input.projectId),
		input.task,
	);
	const document = projectContextDocument({ briefing, traces });
	if (document) {
		await machines.writeTextFile(
			WorkspaceId(providerRef),
			PROJECT_CONTEXT_PATH,
			`${document}\n`,
		);
	}
	return promptTextWithProjectContext({
		task: input.task,
		document,
	});
}
