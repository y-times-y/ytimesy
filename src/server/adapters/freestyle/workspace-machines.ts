import { randomBytes } from "node:crypto";
import { Freestyle, FreestyleApiError } from "freestyle";
import { isolatedAuthSnapshot } from "#/domain/auth-snapshot";
import { type AuthSnapshotId, WorkspaceId } from "#/domain/ids";
import { publicFailureMessage } from "#/domain/project-workspace";
import { guestMutationBlockedReason } from "#/domain/workspace";
import {
	WorkspaceCommandError,
	WorkspaceProvisionError,
} from "#/server/services/errors";
import type {
	CommandOutput,
	CreateProofWorkspaceOptions,
	ProofWorkspace,
	WorkspaceMachines,
} from "#/server/services/workspace-machines";
import { productCreateVmFields } from "./product-vm";
import {
	PROOF_METADATA_PURPOSE,
	privateCodexAuthSnapshotFields,
	proofCreateVmFields,
	proofWorkspaceSlug,
	requestedAuthSnapshotId,
} from "./proof-vm";
import { waitUntilVmRunning } from "./wait-until-running";

function providerMessage(cause: unknown): string {
	return publicFailureMessage(
		cause instanceof FreestyleApiError || cause instanceof Error
			? cause
			: new Error(String(cause)),
	);
}

export function createFreestyleWorkspaceMachines(
	apiKey: string,
): WorkspaceMachines {
	const freestyle = new Freestyle({ apiKey });

	return {
		async createProofWorkspace(
			options: CreateProofWorkspaceOptions = {},
		): Promise<ProofWorkspace> {
			const slug = proofWorkspaceSlug(randomBytes(4).toString("hex"));
			try {
				const created = await freestyle.vms.create(
					proofCreateVmFields({
						slug,
						ttlSeconds: options.ttlSeconds,
						idleTimeoutSeconds: options.idleTimeoutSeconds,
						snapshotId: options.snapshotId,
					}),
				);
				const running = await waitUntilVmRunning(created.vm, "Proof VM");
				return {
					workspaceId: WorkspaceId(created.vmId),
					state: running.state,
					slug: running.slug ?? slug,
					bootedFromSnapshotId: requestedAuthSnapshotId(options.snapshotId),
				};
			} catch (cause) {
				throw new WorkspaceProvisionError({
					operation: "create",
					message: providerMessage(cause),
				});
			}
		},

		async snapshotAuthenticatedWorkspace(workspaceId) {
			try {
				const created = await freestyle.vms
					.ref(workspaceId)
					.snapshot(
						privateCodexAuthSnapshotFields(randomBytes(4).toString("hex")),
					);
				if (created.snapshot.public) {
					await freestyle.vms.snapshots
						.delete(created.snapshotId)
						.catch(() => undefined);
					throw new WorkspaceProvisionError({
						operation: "snapshot",
						message:
							"Freestyle returned a public snapshot; deleted it because Codex credentials cannot live in a shared image",
						providerWorkspaceId: workspaceId,
					});
				}
				return isolatedAuthSnapshot({
					snapshotId: created.snapshotId,
					sourceWorkspaceId: workspaceId,
					public: created.snapshot.public,
				});
			} catch (cause) {
				if (cause instanceof WorkspaceProvisionError) throw cause;
				throw new WorkspaceProvisionError({
					operation: "snapshot",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async destroySnapshot(snapshotId: AuthSnapshotId) {
			try {
				await freestyle.vms.snapshots.delete(snapshotId);
			} catch (cause) {
				if (cause instanceof FreestyleApiError && cause.status === 404) {
					return;
				}
				throw new WorkspaceProvisionError({
					operation: "destroy",
					message: providerMessage(cause),
				});
			}
		},

		async exec(
			workspaceId: WorkspaceId,
			command: string,
			timeoutMs = 120_000,
		): Promise<CommandOutput> {
			try {
				await rejectPausedGuestMutation(freestyle, workspaceId, "exec");
				const result = await freestyle.vms.ref(workspaceId).exec({
					command,
					timeoutMs,
				});
				return {
					exitCode: result.statusCode ?? 124,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
				};
			} catch (cause) {
				if (cause instanceof WorkspaceCommandError) throw cause;
				throw new WorkspaceCommandError({
					operation: "exec",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async writeTextFile(
			workspaceId: WorkspaceId,
			path: string,
			contents: string,
		): Promise<void> {
			try {
				await rejectPausedGuestMutation(freestyle, workspaceId, "writeFile");
				await freestyle.vms.ref(workspaceId).fs.writeTextFile(path, contents);
			} catch (cause) {
				if (cause instanceof WorkspaceCommandError) throw cause;
				throw new WorkspaceCommandError({
					operation: "writeFile",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async readTextFile(
			workspaceId: WorkspaceId,
			path: string,
		): Promise<string | null> {
			try {
				return await freestyle.vms.ref(workspaceId).fs.readTextFile(path);
			} catch (cause) {
				if (
					cause instanceof FreestyleApiError &&
					(cause.status === 404 || cause.code === "NOT_FOUND")
				) {
					return null;
				}
				throw new WorkspaceCommandError({
					operation: "readFile",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async ensureRunning(workspaceId: WorkspaceId): Promise<WorkspaceId> {
			try {
				const vm = freestyle.vms.ref(workspaceId);
				const data = await vm.data();
				if (data.state === "paused" || data.state === "stopped") {
					await vm.start();
				}
				await waitUntilVmRunning(vm, "Workspace VM");
				return workspaceId;
			} catch (cause) {
				throw new WorkspaceProvisionError({
					operation: "create",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async isRunning(workspaceId: WorkspaceId): Promise<boolean> {
			try {
				const data = await freestyle.vms.ref(workspaceId).data();
				return data.state === "running";
			} catch {
				return false;
			}
		},

		async destroy(workspaceId: WorkspaceId): Promise<void> {
			try {
				await freestyle.vms.ref(workspaceId).delete();
			} catch (cause) {
				if (cause instanceof FreestyleApiError && cause.status === 404) {
					return;
				}
				throw new WorkspaceProvisionError({
					operation: "destroy",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async exposeHttp(
			workspaceId: WorkspaceId,
			port: number,
			hostname: string,
		): Promise<string> {
			try {
				const listed = await freestyle.tls.rules.list({
					vmId: workspaceId,
				});
				const already = listed.rules.some(
					(rule) => rule.domain === hostname && rule.destination.port === port,
				);
				if (!already) {
					await freestyle.tls.rules.create({
						action: "allow",
						domain: hostname,
						source: { public: true },
						destination: { vmId: workspaceId, port },
					});
				}
				return `https://${hostname}`;
			} catch (cause) {
				throw new WorkspaceProvisionError({
					operation: "create",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async destroyOrphans(slugPrefix: string): Promise<readonly string[]> {
			try {
				const { vms } = await freestyle.vms.list({
					metadata: `purpose:${PROOF_METADATA_PURPOSE}`,
					limit: 50,
				});
				const deleted: string[] = [];
				for (const vm of vms) {
					if (!(vm.slug ?? "").startsWith(slugPrefix)) continue;
					await freestyle.vms.ref(vm.id).delete();
					deleted.push(vm.id);
				}
				return deleted;
			} catch (cause) {
				throw new WorkspaceProvisionError({
					operation: "reconcile",
					message: providerMessage(cause),
				});
			}
		},

		async snapshotEnvironment(workspaceId, slug) {
			try {
				const created = await freestyle.vms.ref(workspaceId).snapshot({
					slug,
					displayName: "ytimesy project environment",
					autoDeleteSeconds: -1,
				});
				if (created.snapshot.public) {
					await freestyle.vms.snapshots
						.delete(created.snapshotId)
						.catch(() => undefined);
					throw new WorkspaceProvisionError({
						operation: "snapshot",
						message:
							"Freestyle returned a public snapshot; deleted it because project checkouts cannot live in a shared image",
						providerWorkspaceId: workspaceId,
					});
				}
				return created.snapshotId;
			} catch (cause) {
				if (cause instanceof WorkspaceProvisionError) throw cause;
				throw new WorkspaceProvisionError({
					operation: "snapshot",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		async provisionSession(slug, snapshotId) {
			try {
				const existing = await findVmBySlug(freestyle, slug);
				if (existing) {
					const vm = freestyle.vms.ref(existing);
					const data = await vm.data();
					if (data.state === "paused" || data.state === "stopped") {
						await vm.start();
					}
					await waitUntilVmRunning(vm, "Agent session VM");
					return WorkspaceId(existing);
				}
				const created = await freestyle.vms.create(
					productCreateVmFields({ slug, snapshotId }),
				);
				await waitUntilVmRunning(created.vm, "Agent session VM");
				return WorkspaceId(created.vmId);
			} catch (cause) {
				if (cause instanceof FreestyleApiError && cause.status === 409) {
					const recovered = await findVmBySlug(freestyle, slug);
					if (recovered) {
						await waitUntilVmRunning(
							freestyle.vms.ref(recovered),
							"Agent session VM",
						);
						return WorkspaceId(recovered);
					}
				}
				throw new WorkspaceProvisionError({
					operation: "create",
					message: providerMessage(cause),
				});
			}
		},
	};
}

async function rejectPausedGuestMutation(
	freestyle: Freestyle,
	workspaceId: WorkspaceId,
	operation: "exec" | "writeFile",
) {
	const data = await freestyle.vms.ref(workspaceId).data();
	const blocked = guestMutationBlockedReason(data.state);
	if (blocked) {
		throw new WorkspaceCommandError({
			operation,
			message: blocked,
			providerWorkspaceId: workspaceId,
		});
	}
}

async function findVmBySlug(
	freestyle: Freestyle,
	slug: string,
): Promise<string | null> {
	const { vms } = await freestyle.vms.list({ slug, limit: 1 });
	return vms[0]?.id ?? null;
}
