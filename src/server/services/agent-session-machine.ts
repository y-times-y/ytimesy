import type { AgentProviderId } from "#/domain/agent-provider";
import {
	agentSessionMachineSlug,
	projectEnvironmentSnapshotSlug,
	type SessionMachinePlan,
	sessionMachinePlan,
} from "#/domain/agent-session";
import { WorkspaceId } from "#/domain/ids";
import {
	PROJECT_CONTEXT_PATH,
	projectContextDocument,
	relatedTracesForTask,
} from "#/domain/project-context";
import {
	type AgentSessionRecord,
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
			? sessions.find((session) => session.id === input.sessionId)
			: sessions[0];
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
		await injectProjectContext(machines, executed.providerRef, {
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
		? (sessions.find((row) => row.id === input.sessionId) ?? null)
		: (sessions[0] ?? null);
	return { session, providerRef: session?.providerRef ?? null };
}

export async function executeSessionMachinePlan(input: {
	readonly machines: Pick<
		WorkspaceMachines,
		"snapshotEnvironment" | "provisionSession" | "ensureRunning"
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
	await input.saveSessionProviderRef(copied);
	return { providerRef: copied, planKind: plan.kind };
}

async function injectProjectContext(
	machines: WorkspaceMachines,
	providerRef: string,
	input: { readonly projectId: string; readonly task: string },
) {
	const briefing = await loadProjectBriefing(input.projectId);
	const traces = relatedTracesForTask(
		await listProjectTraces(input.projectId),
		input.task,
	);
	const document = projectContextDocument({ briefing, traces });
	if (!document) return;
	await machines.writeTextFile(
		WorkspaceId(providerRef),
		PROJECT_CONTEXT_PATH,
		`${document}\n`,
	);
}
