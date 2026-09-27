import { projectEnvironmentSnapshotSlug } from "../../domain/agent-session";
import { projectCheckoutFromFullName } from "../../domain/project-checkout";
import { projectFolderName } from "../../domain/projects";
import {
	sessionCloneBranch,
	sessionWorkingBranch,
} from "../../domain/session-branch";
import {
	needsMachineCreate,
	needsMachineRecover,
	publicFailureMessage,
	workspaceSlug,
} from "../../domain/project-workspace";
import { toolsSnapshotIdFromEnv } from "../../domain/workspace-boot-snapshot";
import {
	authorizedRepository,
	repositoryBranchSha,
} from "../adapters/github";
import { projectForOwner } from "../adapters/projects";
import { githubAccessToken } from "../auth/github-connection";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	claimWorkspaceForJob,
	recordWorkspaceEvent,
	saveProviderRef,
	saveTemplateSnapshot,
	saveTemplateSource,
	saveWorkspaceStatus,
	workspaceById,
} from "../adapters/workspaces";
import { readToolsSnapshotId } from "../records/tools-snapshot-store";
import { prepareProjectCheckout } from "../services/prepare-project-checkout";
import { removeCodexCredentialsFromProjectTemplate } from "../services/project-template-credentials";

/**
 * Recovers a recorded provider_ref instead of creating a second VM when a
 * previous attempt timed out after remote creation. Installation tokens are
 * written to a temp file on the VM and deleted during clone; they are never
 * stored in argv or workspace_event.
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
		const defaultBranch = await projectDefaultBranch(userId, project);
		const checkout = projectCheckoutFromFullName({
			fullName: project.fullName,
			branch: sessionCloneBranch({
				selectedBranch: project.branch,
				defaultBranch,
				title: projectFolderName(project.fullName),
				id: String(project.repositoryId),
			}),
			workingBranch: sessionWorkingBranch({
				selectedBranch: project.branch,
				defaultBranch,
				title: projectFolderName(project.fullName),
				id: String(project.repositoryId),
			}),
			installationId: project.installationId,
		});
		if (!checkout) throw new Error("Repository name is missing.");
		await recordWorkspaceEvent(userId, workspaceId, "Preparing workspace.");
		const resolved = await resolveMachine(claimed, runtime);
		const providerRef = resolved.providerRef;
		await saveWorkspaceStatus(workspaceId, "cloning");
		const home = await guestHome(runtime, providerRef);
		await prepareProjectCheckout({
			host: {
				exec: (command, timeoutMs) =>
					runtime.exec(providerRef, ["bash", "-lc", command], {}, timeoutMs),
				writeTextFile: (path, contents) =>
					runtime.writeTextFile(providerRef, path, contents),
			},
			owner: checkout.owner,
			name: checkout.name,
			branch: checkout.branch,
			workingBranch: checkout.workingBranch,
			installationId: checkout.installationId,
			home,
			onCloned: async () => {
				await recordWorkspaceEvent(
					userId,
					workspaceId,
					`Cloned ${project.fullName} at ${checkout.workingBranch}.`,
				);
				await saveWorkspaceStatus(workspaceId, "installing");
			},
			onInstalled: () =>
				recordWorkspaceEvent(userId, workspaceId, "Installed dependencies."),
		});
		const ready = await saveWorkspaceStatus(workspaceId, "ready");
		if (providerRef) {
			try {
				await removeCodexCredentialsFromProjectTemplate(runtime, providerRef);
				const snapshotId = await runtime.snapshot(
					providerRef,
					projectEnvironmentSnapshotSlug(workspaceId),
				);
				const sealed = await saveTemplateSnapshot(workspaceId, snapshotId);
				try {
					const sourceSha = await repositoryBranchSha(
						await githubAccessToken(userId),
						project.fullName,
						checkout.branch,
					);
					if (sourceSha && checkout.branch)
						await saveTemplateSource(workspaceId, checkout.branch, sourceSha);
				} catch {
					// Snapshot is already sealed; source SHA can be recorded on refresh.
				}
				await runtime.pause?.(providerRef);
				await recordWorkspaceEvent(
					userId,
					workspaceId,
					"Sealed project environment snapshot.",
				);
				await recordWorkspaceEvent(userId, workspaceId, "Workspace is ready.");
				return sealed ?? ready;
			} catch (error) {
				await recordWorkspaceEvent(
					userId,
					workspaceId,
					`Project snapshot not sealed: ${publicFailureMessage(error)}`,
				);
			}
		}
		await recordWorkspaceEvent(userId, workspaceId, "Workspace is ready.");
		return ready;
	} catch (error) {
		const message = publicFailureMessage(error);
		await saveWorkspaceStatus(workspaceId, "failed", message);
		await recordWorkspaceEvent(userId, workspaceId, message);
		throw error;
	}
}

async function projectDefaultBranch(
	userId: string,
	project: { installationId: number; repositoryId: number; branch: string },
) {
	try {
		const repository = await authorizedRepository(
			await githubAccessToken(userId),
			project.installationId,
			project.repositoryId,
		);
		return repository.defaultBranch;
	} catch {
		return project.branch;
	}
}

async function guestHome(runtime: WorkspaceRuntime, providerRef: string) {
	const result = await runtime.exec(
		providerRef,
		["bash", "-lc", `printf '%s' "\${HOME:-/home/ubuntu}"`],
		{},
		15_000,
	);
	const home = result.stdout.trim();
	return home || "/home/ubuntu";
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
		return {
			providerRef: (await saveProviderRef(workspace.id, recovered))
				.providerRef as string,
		};
	}
	const existing = await runtime.findBySlug(slug);
	if (existing)
		return {
			providerRef: (await saveProviderRef(workspace.id, existing))
				.providerRef as string,
		};
	if (
		!needsMachineCreate(workspace.status, workspace.providerRef) &&
		workspace.providerRef
	)
		return { providerRef: workspace.providerRef };
	const snapshotId = toolsSnapshotIdFromEnv() ?? (await readToolsSnapshotId());
	const created = await runtime.provision(
		slug,
		snapshotId ? { snapshotId } : undefined,
	);
	return {
		providerRef: (await saveProviderRef(workspace.id, created))
			.providerRef as string,
	};
}
