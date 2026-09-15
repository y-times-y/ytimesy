import type { AgentProviderId } from "#/domain/agent-provider";
import {
	agentSessionMachineSlug,
	COPIED_SESSION_STATUS_RESETS,
	copiedSessionScratchFileResetCommand,
	copiedSessionScratchResetCommand,
	projectEnvironmentSnapshotSlug,
	type SessionMachinePlan,
	sessionMachinePlan,
	sessionMachineRefsToDestroy,
} from "#/domain/agent-session";
import { WorkspaceId } from "#/domain/ids";
import {
	PROJECT_CONTEXT_PATH,
	projectContextDocument,
	promptTextWithProjectContext,
	relatedTracesForTask,
} from "#/domain/project-context";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	childAgentSession,
	childAgentSessions,
	deleteAgentSessionForOwner,
	insertAgentSession,
	listAgentSessions,
	saveAgentSessionProviderRef,
	templateAlreadyBound,
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

export async function bindAgentSessionMachine(
	machines: WorkspaceMachines,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly harness: AgentProviderId;
		readonly sessionId?: string;
		readonly createNew?: boolean;
		readonly parentSessionId?: string;
		readonly task?: string;
	},
) {
	const workspace = await workspaceForProject(input.userId, input.projectId);
	if (workspace?.status !== "ready" || !workspace.providerRef) {
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
	const session =
		selected ??
		(await insertAgentSession({
			userId: input.userId,
			projectId: input.projectId,
			workspaceId: workspace.id,
			harness: input.harness,
			parentSessionId: input.parentSessionId,
			title: input.parentSessionId ? "Side chat" : undefined,
		}));
	const bound = await templateAlreadyBound(workspace.id, workspace.providerRef);
	const executed = await executeSessionMachinePlan({
		machines,
		sessionId: session.id,
		sessionProviderRef: session.providerRef,
		workspaceId: workspace.id,
		templateSnapshotId: workspace.templateSnapshotId,
		templateProviderRef: workspace.providerRef,
		templateAlreadyBound:
			bound && session.providerRef !== workspace.providerRef,
		saveTemplateSnapshot: (snapshotId) =>
			saveTemplateSnapshot(workspace.id, snapshotId).then(() => undefined),
		saveSessionProviderRef: (providerRef) =>
			saveAgentSessionProviderRef(session.id, providerRef).then(
				() => undefined,
			),
	});
	if (executed.planKind !== "resume") {
		await syncProjectContextForTask(machines, executed.providerRef, {
			projectId: input.projectId,
			task: input.task ?? session.title,
		});
	}
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
	readonly templateProviderRef: string;
	readonly templateAlreadyBound: boolean;
	readonly saveTemplateSnapshot: (snapshotId: string) => Promise<void>;
	readonly saveSessionProviderRef: (providerRef: string) => Promise<void>;
}): Promise<{ providerRef: string; planKind: SessionMachinePlan["kind"] }> {
	let snapshotId = input.templateSnapshotId;
	let plan = sessionMachinePlan({
		sessionProviderRef: input.sessionProviderRef,
		templateSnapshotId: snapshotId,
		templateProviderRef: input.templateProviderRef,
		templateAlreadyBound: input.templateAlreadyBound,
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
			templateAlreadyBound: true,
		});
	}
	if (plan.kind === "blocked") throw new Error(plan.reason);
	if (plan.kind === "resume" || plan.kind === "attach-legacy") {
		await input.machines.ensureRunning(WorkspaceId(plan.providerRef));
		if (!input.sessionProviderRef)
			await input.saveSessionProviderRef(plan.providerRef);
		return { providerRef: plan.providerRef, planKind: plan.kind };
	}
	if (plan.kind !== "copy-snapshot") {
		throw new Error("Could not copy the project snapshot.");
	}
	const copied = await input.machines.provisionSession(
		agentSessionMachineSlug(input.sessionId),
		plan.snapshotId,
	);
	await resetCopiedSessionScratch(input.machines, copied);
	await input.saveSessionProviderRef(copied);
	return { providerRef: copied, planKind: plan.kind };
}

/**
 * Guest `rm` of `/tmp` can fail when the snapshot files are root-owned
 * (sticky bit). Freestyle `exec` is also not a shell, so the file list is
 * removed with a direct `rm` in addition to `bash -lc`. Status files are
 * overwritten through the FS API so Connect cannot reload the template chat.
 */
async function resetCopiedSessionScratch(
	machines: Pick<WorkspaceMachines, "exec" | "writeTextFile">,
	copied: WorkspaceId,
) {
	await machines.exec(copied, copiedSessionScratchFileResetCommand(), 15_000);
	await machines.exec(copied, copiedSessionScratchResetCommand(), 15_000);
	for (const file of COPIED_SESSION_STATUS_RESETS) {
		await machines.writeTextFile(copied, file.path, file.contents);
	}
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
