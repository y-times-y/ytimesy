import { randomBytes } from "node:crypto";
import { Freestyle, FreestyleApiError, type Vm } from "freestyle";
import { isolatedAuthSnapshot } from "#/domain/auth-snapshot";
import { type AuthSnapshotId, WorkspaceId } from "#/domain/ids";
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
import {
	PROOF_METADATA_PURPOSE,
	privateCodexAuthSnapshotFields,
	proofCreateVmFields,
	proofWorkspaceSlug,
} from "./proof-vm";

function providerMessage(cause: unknown): string {
	if (cause instanceof FreestyleApiError) return cause.message;
	if (cause instanceof Error) return cause.message;
	return String(cause);
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
				const running = await waitUntilRunning(created.vm);
				return {
					workspaceId: WorkspaceId(created.vmId),
					state: running.state,
					slug: running.slug ?? slug,
					bootedFromSnapshotId:
						running.snapshotId ?? options.snapshotId ?? null,
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
				await freestyle.vms.ref(workspaceId).fs.writeTextFile(path, contents);
			} catch (cause) {
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
	};
}

async function waitUntilRunning(vm: Vm) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const data = await vm.data();
		if (data.state === "running") return data;
		if (data.state === "stopped") {
			throw new WorkspaceProvisionError({
				operation: "create",
				message: "Proof VM stopped before it became running",
				providerWorkspaceId: vm.id,
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new WorkspaceProvisionError({
		operation: "create",
		message: "Proof VM did not become running",
		providerWorkspaceId: vm.id,
	});
}
