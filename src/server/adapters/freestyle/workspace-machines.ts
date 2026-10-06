import { randomBytes } from "node:crypto";
import { Freestyle, FreestyleApiError } from "freestyle";
import { isolatedAuthSnapshot } from "#/domain/auth-snapshot";
import { type AuthSnapshotId, WorkspaceId } from "#/domain/ids";
import {
	effectiveMachineResources,
	machineSize,
	machineSizeId,
} from "#/domain/machine-size";
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
import { abortableFreestyleFetch } from "./abortable-fetch";
import {
	deleteFreestyleCodexSession,
	resolveFreestyleCodexRuntime,
} from "./codex-runner";
import {
	PRODUCT_IDLE_TIMEOUT_SECONDS,
	productCreateVmFields,
	productIdleTimeoutNeedsUpdate,
	WORKSPACE_METADATA_PURPOSE,
} from "./product-vm";
import {
	PROOF_METADATA_PURPOSE,
	privateAuthSnapshotFields,
	proofCreateVmFields,
	proofWorkspaceSlug,
	requestedAuthSnapshotId,
} from "./proof-vm";
import {
	admitVmCreate,
	admitVmResume,
	infrastructureAdmissionEnabled,
} from "./usage-admission";
import { waitUntilVmRunning } from "./wait-until-running";
import { restoreRetainedWorkspace } from "./workspace-retention";

function providerMessage(cause: unknown): string {
	return publicFailureMessage(
		cause instanceof FreestyleApiError || cause instanceof Error
			? cause
			: new Error(String(cause)),
	);
}

export function createFreestyleWorkspaceMachines(
	apiKey: string,
	options: { signal?: AbortSignal } = {},
): WorkspaceMachines {
	const freestyle = new Freestyle({
		apiKey,
		...(options.signal
			? { fetch: abortableFreestyleFetch(options.signal) }
			: {}),
	});

	const machines: WorkspaceMachines = {
		restoreRetainedSession: (userId, sessionId, oldVmId) =>
			restoreRetainedWorkspace(freestyle, userId, sessionId, oldVmId),
		destroyCodexSession: (userId, sessionId) =>
			deleteFreestyleCodexSession(apiKey, userId, sessionId),
		codexRuntime: (input) =>
			resolveFreestyleCodexRuntime(apiKey, machines, input),
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

		async snapshotAuthenticatedWorkspace(workspaceId, provider = "codex") {
			try {
				const created = await freestyle.vms
					.ref(workspaceId)
					.snapshot(
						privateAuthSnapshotFields(provider, randomBytes(4).toString("hex")),
					);
				if (created.snapshot.public) {
					await freestyle.vms.snapshots
						.delete(created.snapshotId)
						.catch(() => undefined);
					throw new WorkspaceProvisionError({
						operation: "snapshot",
						message:
							"Freestyle returned a public snapshot; deleted it because credentials cannot live in a shared image",
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
				if (infrastructureAdmissionEnabled())
					await resumeProductVm(
						freestyle.vms.ref(workspaceId),
						"Workspace VM",
						Math.ceil(timeoutMs / 1000),
					);
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
				if (infrastructureAdmissionEnabled())
					await resumeProductVm(freestyle.vms.ref(workspaceId), "Workspace VM");
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
				await resumeProductVm(vm, "Workspace VM");
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

		async provisionSession(slug, snapshotId, sizeId) {
			const requested = machineSize(sizeId);
			const requestedResources = {
				cpu: requested.cpu,
				memory: requested.memory,
				storage: requested.storage,
			};
			try {
				const existing = await findVmBySlug(freestyle, slug);
				if (existing) {
					await verifyCopiedMachineSize(freestyle.vms.ref(existing));
					await resumeProductVm(
						freestyle.vms.ref(existing),
						"Agent session VM",
					);
					return WorkspaceId(existing);
				}
				return WorkspaceId(
					await admitVmCreate(
						freestyle,
						slug,
						snapshotId,
						async (cap) => {
							const created = await freestyle.vms.create({
								...productCreateVmFields({ slug, snapshotId }),
								metadata: {
									purpose: WORKSPACE_METADATA_PURPOSE,
									machine_size: requested.id,
								},
								...(cap === undefined
									? {}
									: { maxRunTotalSeconds: cap, automaticRestart: false }),
							});
							try {
								await waitUntilVmRunning(created.vm, "Agent session VM");
								const current = (await created.vm.data()).resources;
								const target = effectiveMachineResources(
									current,
									requestedResources,
								);
								if (
									target.cpu !== current.cpu ||
									target.memory !== current.memory ||
									target.storage !== current.storage
								)
									await created.vm.resize(target);
							} catch (error) {
								// This copy has not been handed to a chat or executed any user work.
								await created.vm.delete().catch(() => undefined);
								throw error;
							}
							return created.vmId;
						},
						300,
						requestedResources,
					),
				);
			} catch (cause) {
				if (cause instanceof FreestyleApiError && cause.status === 409) {
					const recovered = await findVmBySlug(freestyle, slug);
					if (recovered) {
						await verifyCopiedMachineSize(freestyle.vms.ref(recovered));
						await resumeProductVm(
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
	return machines;
}

/** A failed resize must not become a silently undersized workspace on retry. Legacy VMs keep their existing shape. */
async function verifyCopiedMachineSize(
	vm: ReturnType<Freestyle["vms"]["ref"]>,
) {
	const data = await vm.data();
	if (!data.metadata?.machine_size) return;
	const requested = machineSize(
		machineSizeId.parse(data.metadata.machine_size),
	);
	if (
		data.resources.cpu < requested.cpu ||
		data.resources.memory < requested.memory ||
		data.resources.storage < requested.storage
	)
		throw new Error(
			"Workspace sizing did not complete. The unbound machine needs recovery before it can be used.",
		);
}

async function resumeProductVm(
	vm: ReturnType<Freestyle["vms"]["ref"]>,
	label: string,
	requiredSeconds = 60,
) {
	const data = await vm.data();
	await admitVmResume(vm, data, requiredSeconds);
	if (productIdleTimeoutNeedsUpdate(data.idleTimeoutSeconds)) {
		await vm
			.update({ idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS })
			.catch(() => undefined);
	}
	if (data.state === "paused" || data.state === "stopped") {
		await vm.start();
	}
	await waitUntilVmRunning(vm, label);
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
