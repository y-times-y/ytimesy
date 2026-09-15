import {
	needsMachineCreate,
	needsMachineRecover,
	publicFailureMessage,
	workspaceSlug,
} from "../../domain/project-workspace";
import { projectForOwner } from "../adapters/projects";
import {
	cloneRepositoryArgv,
	githubCloneEnv,
	installArgv,
	listLockfilesArgv,
	repositoryDirectory,
} from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	claimWorkspaceForJob,
	recordWorkspaceEvent,
	saveProviderRef,
	saveWorkspaceStatus,
	workspaceById,
} from "../adapters/workspaces";
import { loadAgentSnapshotId } from "../auth/agent-account";
import { githubAccessToken } from "../auth/github-connection";

/**
 * Recovers a recorded provider_ref instead of creating a second VM when a
 * previous attempt timed out after remote creation. GitHub tokens stay in
 * command env and are never written to workspace_event.
 */
export async function runWorkspacePreparation(
	workspaceId: string,
	runtime: WorkspaceRuntime,
) {
	const claimed =
		(await claimWorkspaceForJob(workspaceId)) ??
		(await workspaceById(workspaceId));
	if (!claimed || claimed.status === "ready") return claimed;
	const userId = claimed.userId;
	try {
		const project = await projectForOwner(userId, claimed.projectId);
		if (!project) throw new Error("Project is not available.");
		await recordWorkspaceEvent(userId, workspaceId, "Preparing workspace.");
		const providerRef = await resolveMachine(claimed, runtime);
		await saveWorkspaceStatus(workspaceId, "cloning");
		const directory = repositoryDirectory(project.fullName);
		const token = await githubAccessToken(userId);
		await runCommand(
			runtime,
			providerRef,
			cloneRepositoryArgv(project.fullName, project.branch, directory),
			githubCloneEnv(token),
			10 * 60 * 1000,
		);
		await recordWorkspaceEvent(
			userId,
			workspaceId,
			`Cloned ${project.fullName} at ${project.branch}.`,
		);
		await saveWorkspaceStatus(workspaceId, "installing");
		const listing = await runCommand(
			runtime,
			providerRef,
			listLockfilesArgv(directory),
			{},
			30 * 1000,
		);
		const lockfiles = listing.stdout.split("\n").map((line) => line.trim());
		await runCommand(
			runtime,
			providerRef,
			installArgv(directory, lockfiles),
			{},
			15 * 60 * 1000,
		);
		await recordWorkspaceEvent(userId, workspaceId, "Installed dependencies.");
		const ready = await saveWorkspaceStatus(workspaceId, "ready");
		await recordWorkspaceEvent(userId, workspaceId, "Workspace is ready.");
		return ready;
	} catch (error) {
		const message = publicFailureMessage(error);
		await saveWorkspaceStatus(workspaceId, "failed", message);
		await recordWorkspaceEvent(userId, workspaceId, message);
		throw error;
	}
}

async function resolveMachine(
	workspace: {
		id: string;
		userId: string;
		status: import("../../domain/project-workspace").WorkspaceStatus;
		providerRef: string | null;
	},
	runtime: WorkspaceRuntime,
) {
	const slug = workspaceSlug(workspace.id);
	if (needsMachineRecover(workspace.status, workspace.providerRef)) {
		const recovered = await runtime.recover(workspace.providerRef as string);
		return (await saveProviderRef(workspace.id, recovered))
			.providerRef as string;
	}
	const existing = await runtime.findBySlug(slug);
	if (existing)
		return (await saveProviderRef(workspace.id, existing))
			.providerRef as string;
	if (
		!needsMachineCreate(workspace.status, workspace.providerRef) &&
		workspace.providerRef
	)
		return workspace.providerRef;
	const snapshotId = await loadAgentSnapshotId(workspace.userId);
	const created = await runtime.provision(
		slug,
		snapshotId ? { snapshotId } : undefined,
	);
	return (await saveProviderRef(workspace.id, created)).providerRef as string;
}

async function runCommand(
	runtime: WorkspaceRuntime,
	providerRef: string,
	argv: string[],
	env: Record<string, string>,
	timeoutMs: number,
) {
	const result = await runtime.exec(providerRef, argv, env, timeoutMs);
	if (result.exitCode !== 0)
		throw new Error(
			result.stderr.trim() ||
				result.stdout.trim() ||
				"Workspace command failed.",
		);
	return result;
}
