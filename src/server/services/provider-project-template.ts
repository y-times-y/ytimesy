import { createHash } from "node:crypto";
import type { AgentProviderId } from "#/domain/agent-provider";
import { WorkspaceId } from "#/domain/ids";
import { projectCheckoutFromFullName } from "#/domain/project-checkout";
import { FREESTYLE_EXEC_TIMEOUT_MS_MAX } from "#/server/adapters/freestyle/product-vm";
import { projectForOwner } from "#/server/adapters/projects";
import {
	authSnapshotFingerprint,
	claimWorkspaceProviderTemplate,
	completeWorkspaceProviderTemplate,
	failWorkspaceProviderTemplate,
	releaseWorkspaceProviderTemplateMachine,
	renewWorkspaceProviderTemplateClaim,
	saveWorkspaceProviderTemplateMachine,
	workspaceProviderTemplate,
} from "#/server/adapters/workspace-provider-templates";
import { loadHarnessSnapshotId } from "#/server/auth/agent-account";
import { prepareProjectCheckout } from "./prepare-project-checkout";
import type { WorkspaceMachines } from "./workspace-machines";

type Provider = "codex" | "claude";

function templateSlug(
	workspaceId: string,
	provider: Provider,
	sources: string,
) {
	const hash = createHash("sha256")
		.update(`${workspaceId}:${sources}`)
		.digest("hex")
		.slice(0, 16);
	return `ytimesy-tpl-${workspaceId.slice(0, 8)}-${provider}-${hash}`;
}

/**
 * A VM snapshot cannot merge with another snapshot. Build one private image
 * from the user's provider login, then clone/install the chosen repository once.
 * Every subsequent writer copies that combined image.
 */
export async function providerProjectTemplateSnapshot(input: {
	readonly machines: WorkspaceMachines;
	readonly userId: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly projectSnapshotId: string | null;
	readonly harness: AgentProviderId;
}) {
	// Codex credentials contain a rotating refresh token. Never copy them into
	// an execution template; each writer starts from the credential-free project.
	if (input.harness !== "claude") {
		return input.projectSnapshotId;
	}
	const provider = input.harness;
	const authSnapshotId = await loadHarnessSnapshotId(input.userId, provider);
	if (!authSnapshotId) return input.projectSnapshotId;
	if (!input.projectSnapshotId) {
		throw new Error("Prepare the project before starting an agent.");
	}
	const desired = {
		workspaceId: input.workspaceId,
		provider,
		authSnapshotId,
		projectSnapshotId: input.projectSnapshotId,
	};
	const fingerprint = authSnapshotFingerprint(authSnapshotId);
	const existing = await workspaceProviderTemplate(input.workspaceId, provider);
	if (
		existing?.status === "ready" &&
		existing.authSnapshotFingerprint === fingerprint &&
		existing.projectSnapshotId === input.projectSnapshotId &&
		existing.snapshotId
	) {
		return existing.snapshotId;
	}
	const claim = await claimWorkspaceProviderTemplate(desired);
	if (!claim) return await waitForProviderTemplate(desired);
	const heartbeat = setInterval(
		() =>
			void renewWorkspaceProviderTemplateClaim(
				claim.workspaceId,
				provider,
				claim.claimedAt,
			).catch(() => undefined),
		10_000,
	);
	heartbeat.unref();
	try {
		return await buildProviderTemplate(input.machines, input, {
			...claim,
			authSnapshotId,
		});
	} catch (cause) {
		await failWorkspaceProviderTemplate(
			claim.workspaceId,
			provider,
			cause instanceof Error ? cause.message : String(cause),
			claim.claimedAt,
		).catch(() => undefined);
		throw cause;
	} finally {
		clearInterval(heartbeat);
	}
}

async function buildProviderTemplate(
	machines: WorkspaceMachines,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly workspaceId: string;
	},
	claim: {
		readonly provider: Provider;
		readonly authSnapshotId: string;
		readonly projectSnapshotId: string;
		readonly providerRef: string | null;
		readonly claimedAt: string;
	},
) {
	const project = await projectForOwner(input.userId, input.projectId);
	if (!project) throw new Error("The project is not available.");
	const checkout = projectCheckoutFromFullName({
		fullName: project.fullName,
		branch: project.branch,
		workingBranch: project.branch,
		installationId: project.installationId,
	});
	if (!checkout) throw new Error("The project checkout is invalid.");
	const slug = templateSlug(
		input.workspaceId,
		claim.provider,
		`${claim.authSnapshotId}:${claim.projectSnapshotId}`,
	);
	const vm = claim.providerRef
		? WorkspaceId(claim.providerRef)
		: await machines.provisionSession(slug, claim.authSnapshotId);
	await saveWorkspaceProviderTemplateMachine(
		input.workspaceId,
		claim.provider,
		vm,
		claim.claimedAt,
	);
	await machines.ensureRunning(vm);
	const homeResult = await machines.exec(vm, "printenv HOME", 15_000);
	await prepareProjectCheckout({
		host: {
			exec: (command, timeoutMs) =>
				machines.exec(
					vm,
					command,
					Math.min(timeoutMs, FREESTYLE_EXEC_TIMEOUT_MS_MAX),
				),
			writeTextFile: (path, contents) =>
				machines.writeTextFile(vm, path, contents),
		},
		owner: checkout.owner,
		name: checkout.name,
		branch: checkout.branch,
		workingBranch: checkout.workingBranch,
		installationId: checkout.installationId,
		home:
			homeResult.exitCode === 0
				? homeResult.stdout.trim() || "/home/ubuntu"
				: "/home/ubuntu",
	});
	const snapshotId = await machines.snapshotEnvironment(vm, slug);
	await completeWorkspaceProviderTemplate(
		input.workspaceId,
		claim.provider,
		snapshotId,
		claim.claimedAt,
	);
	try {
		await machines.destroy(vm);
		await releaseWorkspaceProviderTemplateMachine(
			input.workspaceId,
			claim.provider,
			snapshotId,
		);
	} catch {
		// The private snapshot is ready; the unused builder can be cleaned later.
	}
	return snapshotId;
}

async function waitForProviderTemplate(input: {
	readonly workspaceId: string;
	readonly provider: Provider;
	readonly authSnapshotId: string;
	readonly projectSnapshotId: string;
}) {
	for (let poll = 0; poll < 180; poll += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
		const current = await workspaceProviderTemplate(
			input.workspaceId,
			input.provider,
		);
		if (
			!current ||
			current.authSnapshotFingerprint !==
				authSnapshotFingerprint(input.authSnapshotId) ||
			current.projectSnapshotId !== input.projectSnapshotId
		) {
			throw new Error("The project template changed while preparing.");
		}
		if (current.status === "ready" && current.snapshotId) {
			return current.snapshotId;
		}
		if (current.status === "failed") {
			throw new Error("The authenticated project template failed to prepare.");
		}
	}
	throw new Error("The authenticated project template is still preparing.");
}
