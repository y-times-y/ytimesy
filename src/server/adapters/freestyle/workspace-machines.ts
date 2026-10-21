import { randomBytes } from "node:crypto";
import { Freestyle, FreestyleApiError, type VmData } from "freestyle";
import { type AuthSnapshotId, WorkspaceId } from "#/domain/ids";
import {
	effectiveMachineResources,
	machineSize,
	machineSizeId,
} from "#/domain/machine-size";
import { SCRUB_MEMORY_CREDENTIAL } from "#/domain/memory-repo";
import { publicFailureMessage } from "#/domain/project-workspace";
import { guestMutationBlockedReason } from "#/domain/workspace";
import {
	WorkspaceCommandError,
	WorkspaceProvisionError,
} from "#/server/services/errors";
import {
	guestServiceHostname,
	persistentGuestCapabilityRunner,
} from "#/server/services/persistent-guest-capability";
import { stepTimingEnabled, timedFetch } from "#/server/services/step-timing";
import type {
	CommandOutput,
	CreateProofWorkspaceOptions,
	ProofWorkspace,
	WorkspaceMachines,
} from "#/server/services/workspace-machines";
import { abortableFreestyleFetch } from "./abortable-fetch";
import {
	ensureVmEdgeAuthorizer,
	listVmEdgeRoutes,
	publishVmEdgeRoute,
	withdrawVmEdgeRoutes,
} from "./edge-routes";
import { forkRunningVm } from "./fork-vm";
import {
	PRODUCT_IDLE_TIMEOUT_SECONDS,
	productCreateVmFields,
	productIdleTimeoutNeedsUpdate,
	WORKSPACE_METADATA_PURPOSE,
} from "./product-vm";
import {
	PROOF_METADATA_PURPOSE,
	proofCreateVmFields,
	proofWorkspaceSlug,
	requestedAuthSnapshotId,
} from "./proof-vm";
import { retryTransientProviderFailure } from "./provider-retry";
import {
	forgetRunningGuest,
	recentlyRunningGuest,
	rememberRunningGuest,
} from "./recent-guest-state";
import { scrubAgentSecrets } from "./scrub-agent-secrets";
import {
	admitVmCreate,
	admitVmResume,
	infrastructureAdmissionEnabled,
	recentAdmissionCovers,
} from "./usage-admission";
import { waitUntilVmRunning } from "./wait-until-running";
import { restoreRetainedWorkspace } from "./workspace-retention";

/** The provider refused the machine shape itself, e.g. above the plan's per-VM vCPU cap. */
class MachineSizeRejected extends Error {
	constructor(readonly size: ReturnType<typeof machineSize>) {
		super(
			`The provider rejected the ${size.name} machine size (${size.cpu} vCPU, ${size.memory / 1024} GiB). Choose a smaller machine size in project settings.`,
		);
		this.name = "MachineSizeRejected";
	}
}

function providerMessage(cause: unknown): string {
	if (cause instanceof MachineSizeRejected) return cause.message;
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
	const transport = globalThis.fetch.bind(globalThis);
	const freestyle = new Freestyle({
		apiKey,
		...(options.signal
			? { fetch: abortableFreestyleFetch(options.signal, transport) }
			: stepTimingEnabled()
				? { fetch: timedFetch("freestyle", transport) }
				: {}),
	});

	const machines: WorkspaceMachines &
		Required<
			Pick<
				WorkspaceMachines,
				"publishHttpRoute" | "listHttpRoutes" | "withdrawHttpRoutes"
			>
		> = {
		restoreRetainedSession: (userId, sessionId, oldVmId) =>
			restoreRetainedWorkspace(freestyle, userId, sessionId, oldVmId),
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
				const result = await onReadyGuest(
					freestyle.vms.ref(workspaceId),
					"exec",
					Math.ceil(timeoutMs / 1000),
					() =>
						freestyle.vms.ref(workspaceId).exec({
							command,
							timeoutMs,
						}),
				);
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
				await onReadyGuest(
					freestyle.vms.ref(workspaceId),
					"writeFile",
					60,
					() => freestyle.vms.ref(workspaceId).fs.writeTextFile(path, contents),
				);
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
				await retryTransientProviderFailure(async () => {
					const data = await vm.data();
					if (!admittedAndRunning(data, 60))
						await resumeProductVm(vm, "Workspace VM", 60, data);
				});
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
				forgetRunningGuest(workspaceId);
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
			return (await machines.publishHttpRoute(workspaceId, { hostname, port }))
				.origin;
		},

		async publishHttpRoute(workspaceId, route) {
			try {
				return await publishVmEdgeRoute(freestyle, workspaceId, route);
			} catch (cause) {
				throw new WorkspaceProvisionError({
					operation: "create",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
				});
			}
		},

		listHttpRoutes: (workspaceId) => listVmEdgeRoutes(freestyle, workspaceId),

		withdrawHttpRoutes: (workspaceId, kinds, port) =>
			withdrawVmEdgeRoutes(freestyle, workspaceId, kinds, port),

		ensureEdgeAuthorizer: (config) => ensureVmEdgeAuthorizer(freestyle, config),

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
			// A snapshot may pause the machine; the next operation reads it fresh.
			forgetRunningGuest(workspaceId);
			try {
				await scrubAgentSecrets(freestyle.vms.ref(workspaceId));
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

		async forkWorkspace(source, slug, sizeId) {
			forgetRunningGuest(source);
			try {
				const fork = await forkRunningVm({
					source: freestyle.vms.ref(source),
					sourceVmId: source,
					boot: (snapshotId) =>
						machines.provisionSession(slug, snapshotId, sizeId),
					deleteSnapshot: (snapshotId) =>
						freestyle.vms.snapshots.delete(snapshotId),
					scrubFork: async (vmId) => {
						const scrubbed = await machines.exec(
							WorkspaceId(vmId),
							SCRUB_MEMORY_CREDENTIAL,
							30_000,
						);
						if (scrubbed.exitCode !== 0)
							throw new Error("the memory clone still holds a token");
					},
					deleteVm: (vmId) => freestyle.vms.ref(vmId).delete(),
				});
				return { vm: WorkspaceId(fork.vmId), forkMs: fork.forkMs };
			} catch (cause) {
				if (cause instanceof WorkspaceProvisionError) throw cause;
				throw new WorkspaceProvisionError({
					operation: "snapshot",
					message: providerMessage(cause),
					providerWorkspaceId: source,
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
			const provision = async () => {
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
									await created.vm.resize(target).catch(async (error) => {
										if (
											error instanceof FreestyleApiError &&
											error.status >= 400 &&
											error.status < 500
										)
											throw new MachineSizeRejected(requested);
										// A resize takes about as long as the provider gateway's
										// timeout; a 5xx there often means it is still finishing.
										if (
											!(
												error instanceof FreestyleApiError &&
												error.status >= 500
											) ||
											!(await resizeLands(created.vm, target))
										)
											throw error;
									});
							} catch (error) {
								// This copy has not been handed to a chat or executed any user work.
								await created.vm.delete().catch(() => undefined);
								if (
									!(error instanceof FreestyleApiError && error.status >= 500)
								)
									throw error;
								// The provider's resize is unavailable: run the chat at the
								// template's size rather than fail it. Without a machine_size
								// tag the later size check accepts this copy.
								console.warn(
									"Machine resize unavailable; using template size.",
									{
										requested: requested.id,
										status: error.status,
									},
								);
								const fallback = await freestyle.vms.create({
									...productCreateVmFields({ slug, snapshotId }),
									metadata: {
										purpose: WORKSPACE_METADATA_PURPOSE,
										machine_size_requested: requested.id,
									},
									...(cap === undefined
										? {}
										: { maxRunTotalSeconds: cap, automaticRestart: false }),
								});
								await waitUntilVmRunning(fallback.vm, "Agent session VM");
								return fallback.vmId;
							}
							return created.vmId;
						},
						300,
						requestedResources,
					),
				);
			};
			try {
				// Slug-keyed: a repeat finds and resumes a VM an earlier attempt created.
				return await retryTransientProviderFailure(provision);
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
	const invokeCapability = persistentGuestCapabilityRunner(
		machines,
		(vm, port) => machines.exposeHttp(vm, port, guestServiceHostname(vm, port)),
	);
	return {
		...machines,
		runCapability: async (vm, request, signal) => {
			signal.throwIfAborted();
			return onReadyGuest(freestyle.vms.ref(vm), "exec", 180, () =>
				invokeCapability(vm, request, signal),
			);
		},
	};
}

/** A failed resize must not become a silently undersized workspace on retry. Legacy VMs keep their existing shape. */
/** Polls for up to a minute for a resize the provider reported as failed. */
async function resizeLands(
	vm: ReturnType<Freestyle["vms"]["ref"]>,
	target: { cpu: number; memory: number; storage: number },
) {
	for (let attempt = 0; attempt < 30; attempt++) {
		const resources = (await vm.data().catch(() => null))?.resources;
		if (
			resources &&
			resources.cpu >= target.cpu &&
			resources.memory >= target.memory &&
			resources.storage >= target.storage
		)
			return true;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	return false;
}

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
	/** A read made just before; the admission re-reads under its lease anyway. */
	read?: VmData,
) {
	const data = read ?? (await vm.data());
	await admitVmResume(vm, data, requiredSeconds);
	if (productIdleTimeoutNeedsUpdate(data.idleTimeoutSeconds)) {
		await vm
			.update({ idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS })
			.catch(() => undefined);
	}
	if (data.state === "paused" || data.state === "stopped") {
		await vm.start();
	}
	return waitUntilVmRunning(vm, label);
}

/** A running VM whose recent admission still covers the operation needs no new admission. */
function admittedAndRunning(data: VmData, requiredSeconds: number) {
	return (
		!productIdleTimeoutNeedsUpdate(data.idleTimeoutSeconds) &&
		recentAdmissionCovers(data, requiredSeconds)
	);
}

/**
 * Admits (and resumes) the VM when admission is on, then refuses guest
 * mutations on a machine that is not running. One provider read suffices when
 * a recent admission still covers the operation; otherwise the full resume
 * path runs and its final running-state read stands in for the refusal check.
 */
async function readyForGuestOperation(
	vm: ReturnType<Freestyle["vms"]["ref"]>,
	operation: "exec" | "writeFile",
	requiredSeconds = 60,
) {
	const known = recentlyRunningGuest(vm.id, requiredSeconds);
	if (known) return known;
	let data = await vm.data();
	if (
		infrastructureAdmissionEnabled() &&
		!admittedAndRunning(data, requiredSeconds)
	)
		data = await resumeProductVm(vm, "Workspace VM", requiredSeconds, data);
	const blocked = guestMutationBlockedReason(data.state);
	if (blocked) {
		throw new WorkspaceCommandError({
			operation,
			message: blocked,
			providerWorkspaceId: WorkspaceId(vm.id),
		});
	}
	return data;
}

/**
 * Runs a guest operation on a ready VM. Its success is recent guest activity
 * on a running machine, which lets the next operation skip the provider read
 * (recent-guest-state.ts); a failure forgets it.
 */
async function onReadyGuest<T>(
	vm: ReturnType<Freestyle["vms"]["ref"]>,
	operation: "exec" | "writeFile",
	requiredSeconds: number,
	run: () => Promise<T>,
) {
	const data = await readyForGuestOperation(vm, operation, requiredSeconds);
	try {
		const result = await run();
		rememberRunningGuest(data);
		return result;
	} catch (cause) {
		forgetRunningGuest(vm.id);
		throw cause;
	}
}

async function findVmBySlug(
	freestyle: Freestyle,
	slug: string,
): Promise<string | null> {
	const { vms } = await freestyle.vms.list({ slug, limit: 1 });
	return vms[0]?.id ?? null;
}
