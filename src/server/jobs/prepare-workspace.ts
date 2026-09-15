import { projectEnvironmentSnapshotSlug } from "../../domain/agent-session";
import {
	projectCheckoutFromFullName,
	projectCheckoutPath,
} from "../../domain/project-checkout";
import {
	needsMachineCreate,
	needsMachineRecover,
	publicFailureMessage,
	workspaceSlug,
} from "../../domain/project-workspace";
import {
	toolsSnapshotIdFromEnv,
	workspaceBootSnapshotId,
} from "../../domain/workspace-boot-snapshot";
import {
	cloneSelectedProjectScript,
	PROJECT_TOKEN_PATH,
} from "../adapters/freestyle/clone-project";
import { githubInstallationAccessToken } from "../adapters/github/installation-token";
import { projectForOwner } from "../adapters/projects";
import { installArgv, listLockfilesArgv } from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	claimWorkspaceForJob,
	recordWorkspaceEvent,
	saveProviderRef,
	saveTemplateSnapshot,
	saveWorkspaceStatus,
	workspaceById,
} from "../adapters/workspaces";
import { loadAgentSnapshotId } from "../auth/agent-account";

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
		const checkout = projectCheckoutFromFullName({
			fullName: project.fullName,
			branch: project.branch,
			installationId: project.installationId,
		});
		if (!checkout) throw new Error("Repository name is missing.");
		await recordWorkspaceEvent(userId, workspaceId, "Preparing workspace.");
		const providerRef = await resolveMachine(claimed, runtime);
		await saveWorkspaceStatus(workspaceId, "cloning");
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
					destination: directory,
				}),
			],
			{},
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
		if (providerRef) {
			try {
				const snapshotId = await runtime.snapshot(
					providerRef,
					projectEnvironmentSnapshotSlug(workspaceId),
				);
				const sealed = await saveTemplateSnapshot(workspaceId, snapshotId);
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
	const snapshotId = workspaceBootSnapshotId({
		userAuthSnapshotId: await loadAgentSnapshotId(workspace.userId),
		toolsSnapshotId: toolsSnapshotIdFromEnv(),
	});
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
				`Workspace command failed (exit ${result.exitCode}).`,
		);
	return result;
}
