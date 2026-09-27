import { projectEnvironmentSnapshotSlug } from "../../domain/agent-session";
import {
	projectCheckoutFromFullName,
	projectCheckoutPath,
} from "../../domain/project-checkout";
import {
	projectSnapshotNeedsRefresh,
	projectSnapshotSourceRef,
} from "../../domain/project-snapshot";
import {
	publicFailureMessage,
	workspaceSlug,
} from "../../domain/project-workspace";
import { projectFolderName } from "../../domain/projects";
import {
	sessionCloneBranch,
	sessionWorkingBranch,
} from "../../domain/session-branch";
import {
	cloneSelectedProjectScript,
	PROJECT_TOKEN_PATH,
} from "../adapters/freestyle/clone-project";
import { authorizedRepository, repositoryBranchSha } from "../adapters/github";
import { resolveGithubAppBot } from "../adapters/github/bot-identity";
import { githubInstallationAccessToken } from "../adapters/github/installation-token";
import { projectForOwner } from "../adapters/projects";
import {
	activateGithubBotCommitHookArgv,
	githubBotCommitHookPath,
	githubBotCommitMsgHook,
	installArgv,
	listLockfilesArgv,
} from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	listReadyWorkspaceIds,
	recordWorkspaceEvent,
	saveProviderRef,
	saveTemplateSnapshot,
	saveTemplateSource,
	workspaceById,
} from "../adapters/workspaces";
import { githubAccessToken } from "../auth/github-connection";
import { removeCodexCredentialsFromProjectTemplate } from "../services/project-template-credentials";

/**
 * Rebuilds a ready project's snapshot when the clone-source commit moved.
 * Status stays ready and the last good snapshot stays active if this fails.
 */
export async function refreshWorkspaceSnapshot(
	workspaceId: string,
	runtime: WorkspaceRuntime,
) {
	const workspace = await workspaceById(workspaceId);
	if (!workspace || workspace.status !== "ready") return workspace;
	const project = await projectForOwner(workspace.userId, workspace.projectId);
	if (!project) return workspace;
	const defaultBranch = await projectDefaultBranch(workspace.userId, project);
	const cloneBranch = sessionCloneBranch({
		selectedBranch: project.branch,
		defaultBranch,
		title: projectFolderName(project.fullName),
		id: String(project.repositoryId),
	});
	const sourceRef = projectSnapshotSourceRef({
		cloneBranch,
		defaultBranch,
	});
	const remoteSha = await repositoryBranchSha(
		await githubAccessToken(workspace.userId),
		project.fullName,
		sourceRef,
	);
	if (
		!projectSnapshotNeedsRefresh({
			sealedSha: workspace.templateSourceSha,
			remoteSha,
		})
	)
		return workspace;
	const checkout = projectCheckoutFromFullName({
		fullName: project.fullName,
		branch: cloneBranch,
		workingBranch: sessionWorkingBranch({
			selectedBranch: project.branch,
			defaultBranch,
			title: projectFolderName(project.fullName),
			id: String(project.repositoryId),
		}),
		installationId: project.installationId,
	});
	if (!checkout) return workspace;
	try {
		await recordWorkspaceEvent(
			workspace.userId,
			workspaceId,
			"Refreshing project snapshot.",
		);
		const providerRef = await resolveReadyTemplate(workspace, runtime);
		const home = await guestHome(runtime, providerRef);
		const directory = projectCheckoutPath(home, checkout.name);
		const token = await githubInstallationAccessToken(checkout.installationId);
		await runtime.writeTextFile(providerRef, PROJECT_TOKEN_PATH, `${token}\n`);
		await runCommand(
			runtime,
			providerRef,
			[
				"bash",
				"-lc",
				cloneSelectedProjectScript({
					owner: checkout.owner,
					name: checkout.name,
					branch: checkout.branch,
					workingBranch: checkout.workingBranch,
					destination: directory,
				}),
			],
			{},
			10 * 60 * 1000,
		);
		const bot = await resolveGithubAppBot();
		if (bot) {
			await runtime.writeTextFile(
				providerRef,
				githubBotCommitHookPath(directory),
				githubBotCommitMsgHook(bot),
			);
			await runCommand(
				runtime,
				providerRef,
				activateGithubBotCommitHookArgv(directory),
				{},
				15_000,
			);
		}
		const listing = await runCommand(
			runtime,
			providerRef,
			listLockfilesArgv(directory),
			{},
			30 * 1000,
		);
		await runCommand(
			runtime,
			providerRef,
			installArgv(
				directory,
				listing.stdout.split("\n").map((line) => line.trim()),
			),
			{},
			15 * 60 * 1000,
		);
		await removeCodexCredentialsFromProjectTemplate(runtime, providerRef);
		const snapshotId = await runtime.snapshot(
			providerRef,
			projectEnvironmentSnapshotSlug(workspaceId),
		);
		await saveTemplateSnapshot(workspaceId, snapshotId);
		if (remoteSha) await saveTemplateSource(workspaceId, sourceRef, remoteSha);
		await runtime.pause?.(providerRef);
		await recordWorkspaceEvent(
			workspace.userId,
			workspaceId,
			"Sealed a newer project environment snapshot.",
		);
		return workspaceById(workspaceId);
	} catch (error) {
		await recordWorkspaceEvent(
			workspace.userId,
			workspaceId,
			`Snapshot refresh skipped: ${publicFailureMessage(error)}`,
		);
		return workspaceById(workspaceId);
	}
}

export async function readyWorkspaceIdsToRefresh() {
	return listReadyWorkspaceIds();
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

async function resolveReadyTemplate(
	workspace: {
		id: string;
		userId: string;
		providerRef: string | null;
		templateSnapshotId?: string | null;
	},
	runtime: WorkspaceRuntime,
) {
	const slug = workspaceSlug(workspace.id);
	if (workspace.providerRef) {
		const recovered = await runtime.recover(workspace.providerRef);
		return (await saveProviderRef(workspace.id, recovered))
			.providerRef as string;
	}
	const existing = await runtime.findBySlug(slug);
	if (existing)
		return (await saveProviderRef(workspace.id, existing))
			.providerRef as string;
	if (!workspace.templateSnapshotId)
		throw new Error("Project snapshot is not available.");
	const created = await runtime.provision(slug, {
		snapshotId: workspace.templateSnapshotId,
	});
	return (await saveProviderRef(workspace.id, created)).providerRef as string;
}

async function guestHome(runtime: WorkspaceRuntime, providerRef: string) {
	const result = await runtime.exec(
		providerRef,
		["bash", "-lc", `printf '%s' "\${HOME:-/home/ubuntu}"`],
		{},
		15_000,
	);
	return result.stdout.trim() || "/home/ubuntu";
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
				`Workspace command failed (exit ${result.exitCode}).`,
		);
	return result;
}
