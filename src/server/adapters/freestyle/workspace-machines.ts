import { randomBytes } from "node:crypto";
import { Freestyle, FreestyleApiError, type VmData } from "freestyle";
import { nextAgentSessionMachineSlug } from "#/domain/agent-session";
import { type AuthSnapshotId, WorkspaceId } from "#/domain/ids";
import {
	effectiveMachineResources,
	machineSize,
	machineSizeId,
} from "#/domain/machine-size";
import { publicFailureMessage } from "#/domain/project-workspace";
import { guestMutationBlockedReason } from "#/domain/workspace";
import {
	clearWakeFailures,
	recordWakeFailure,
} from "#/server/adapters/machine-wake-failures";
import {
	WorkspaceCommandError,
	WorkspaceProvisionError,
} from "#/server/services/errors";
import {
	guestServiceHostname,
	persistentGuestCapabilityRunner,
} from "#/server/services/persistent-guest-capability";
import { stepTimingEnabled, timedFetch } from "#/server/services/step-timing";
import { turnSpan, turnSpanFetch } from "#/server/services/turn-timing";
import type {
	CommandOutput,
	CreateProofWorkspaceOptions,
	ProofWorkspace,
	WorkspaceMachines,
} from "#/server/services/workspace-machines";
import { abortableFreestyleFetch, callSignalFetch } from "./abortable-fetch";
import { boundedFreestyleFetch, fastPollFreestyleFetch } from "./bounded-fetch";
import {
	mintBoxToolIdentity,
	revokeBoxToolIdentity,
} from "./box-tool-identity";
import {
	ensureVmEdgeAuthorizer,
	listVmEdgeRoutes,
	publishVmEdgeRoute,
	withdrawVmEdgeRoutes,
} from "./edge-routes";
import { forkRunningVm } from "./fork-vm";
import {
	logMachineFailure,
	machineFailureDetail,
	machineFailureKind,
	requestIdRecordingFetch,
	resumableMachineStart,
} from "./machine-failure";
import {
	BACKGROUND_IDLE_TIMEOUT_SECONDS,
	PRODUCT_IDLE_TIMEOUT_SECONDS,
	productCreateVmFields,
	productLifecycleUpdate,
	WORKSPACE_METADATA_PURPOSE,
} from "./product-vm";
import {
	PROOF_METADATA_PURPOSE,
	proofCreateVmFields,
	proofWorkspaceSlug,
	requestedAuthSnapshotId,
} from "./proof-vm";
import {
	isTransientProviderFailure,
	PROVIDER_UNAVAILABLE_MESSAGE,
	retryTransientProviderFailure,
} from "./provider-retry";
import {
	forgetRunningGuest,
	recentlyRunningGuest,
	rememberRunningGuest,
} from "./recent-guest-state";
import { SCRUB_VM_TOKENS, scrubAgentSecrets } from "./scrub-agent-secrets";
import { prepareTemplateSnapshot } from "./template-snapshot";
import {
	admitVmCreate,
	admitVmResume,
	infrastructureAdmissionEnabled,
	recentAdmissionCovers,
	startAdmittedVm,
} from "./usage-admission";
import { applyVmNetworkPolicy } from "./vm-network";
import {
	waitUntilGuestAnswers,
	waitUntilGuestReady,
	waitUntilVmRunning,
} from "./wait-until-running";
import {
	rebindWorkspaceRetention,
	restoreRetainedWorkspace,
} from "./workspace-retention";

/** The provider refused the machine shape itself, e.g. above the plan's per-VM vCPU cap. */
class MachineSizeRejected extends Error {
	constructor(readonly size: ReturnType<typeof machineSize>) {
		super(
			`The provider rejected the ${size.name} machine size (${size.cpu} vCPU, ${size.memory / 1024} GiB). Choose a smaller machine size in project settings.`,
		);
		this.name = "MachineSizeRejected";
	}
}

/** Fixed wording for the failure kinds machineFailureReason (api-turn-failure.ts) names. */
export const MACHINE_START_STILL_FINISHING =
	"An earlier start of this machine was still finishing.";
export const PROVIDER_RATE_LIMITED =
	"The machine provider is limiting requests right now.";

function providerMessage(cause: unknown): string {
	if (cause instanceof MachineSizeRejected) return cause.message;
	if (isTransientProviderFailure(cause)) return PROVIDER_UNAVAILABLE_MESSAGE;
	const kind = machineFailureKind(cause);
	if (kind === "conflict") return MACHINE_START_STILL_FINISHING;
	if (kind === "rate-limited") return PROVIDER_RATE_LIMITED;
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
	// A turn's machine call (cancellableMachines) aborts its requests on Stop.
	// Every provider call (a poll loop's included) is a span of the running
	// durable step, so its timing line counts and sums them.
	const transport = turnSpanFetch(
		"freestyle",
		callSignalFetch(
			requestIdRecordingFetch(fastPollFreestyleFetch(boundedFreestyleFetch())),
		),
	);
	const freestyle = new Freestyle({
		apiKey,
		fetch: options.signal
			? abortableFreestyleFetch(options.signal, transport)
			: stepTimingEnabled()
				? timedFetch("freestyle", transport)
				: transport,
	});

	const machines: WorkspaceMachines &
		Required<
			Pick<
				WorkspaceMachines,
				"publishHttpRoute" | "listHttpRoutes" | "withdrawHttpRoutes"
			>
		> = {
		async keepAwakeForBackground(workspaceId) {
			await retryTransientProviderFailure(() =>
				freestyle.vms
					.ref(workspaceId)
					.update({ idleTimeoutSeconds: BACKGROUND_IDLE_TIMEOUT_SECONDS }),
			);
		},
		async settleIdleTimeout(workspaceId) {
			await retryTransientProviderFailure(() =>
				freestyle.vms
					.ref(workspaceId)
					.update({ idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS }),
			);
		},
		async pause(workspaceId) {
			// The next guest operation must read the paused state, not reuse
			// the running read behind the last one (recent-guest-state.ts).
			forgetRunningGuest(workspaceId);
			// Not retried: a pause that did land answers a repeat with a conflict,
			// and a missed pause only costs the running time it would have saved.
			await freestyle.vms.ref(workspaceId).pause();
		},
		async applyNetworkPolicy(workspaceId, policy) {
			await retryTransientProviderFailure(() =>
				applyVmNetworkPolicy(freestyle, workspaceId, policy),
			);
		},
		restoreRetainedSession: (userId, sessionId, oldVmId) =>
			restoreRetainedWorkspace(freestyle, userId, sessionId, oldVmId),
		rebindRetainedSession: rebindWorkspaceRetention,
		async replacementSessionSlug(sessionId, oldVmId) {
			const old = await freestyle.vms.ref(oldVmId).data();
			return nextAgentSessionMachineSlug(sessionId, old.slug);
		},
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
				const running = await waitUntilGuestReady(created.vm, "Proof VM");
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
			const startedAt = Date.now();
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
				// 124 is also what a provider answer with no exit status becomes: say
				// so, with how long it took and what came back (never the command).
				if (result.statusCode == null)
					console.warn("Machine command returned no exit status.", {
						vm: workspaceId,
						budgetMs: timeoutMs,
						elapsedMs: Date.now() - startedAt,
						stdoutBytes: result.stdout?.length ?? 0,
						stderr: String(result.stderr ?? "")
							.replace(/https?:\/\/\S+/g, "<url>")
							.slice(-200),
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
				// Writing the same contents again is harmless.
				await retryTransientProviderFailure(() =>
					onReadyGuest(freestyle.vms.ref(workspaceId), "writeFile", 60, () =>
						freestyle.vms.ref(workspaceId).fs.writeTextFile(path, contents),
					),
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
				return await retryTransientProviderFailure(() =>
					freestyle.vms.ref(workspaceId).fs.readTextFile(path),
				);
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

		async readFile(
			workspaceId: WorkspaceId,
			path: string,
		): Promise<Uint8Array | null> {
			try {
				return await retryTransientProviderFailure(() =>
					freestyle.vms.ref(workspaceId).fs.readFile(path),
				);
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
			// A guest that answered within the last seconds, under an admission
			// that still covers a minute, is running: no provider read is needed
			// (a turn ensures its machine twice, at binding and before its checkout).
			const known = recentlyRunningGuest(workspaceId, 60);
			if (known && !productLifecycleUpdate(known)) return workspaceId;
			try {
				const vm = freestyle.vms.ref(workspaceId);
				// Resumable: a resume interrupted by a restart is simply run again.
				await turnSpan("vm:ensureRunning", () =>
					resumableMachineStart(
						async () => {
							const data = await vm.data();
							if (!admittedAndRunning(data, 60))
								await resumeProductVm(vm, "Workspace VM", 60, data);
						},
						{ operation: "ensureRunning", vmId: workspaceId },
					),
				);
				// Never throws; the turn need not wait for the bookkeeping.
				void clearWakeFailures(workspaceId);
				return workspaceId;
			} catch (cause) {
				await recordWakeFailure(workspaceId, cause);
				throw new WorkspaceProvisionError({
					operation: "create",
					message: providerMessage(cause),
					providerWorkspaceId: workspaceId,
					detail: machineFailureDetail(cause),
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

		async snapshotEnvironment(workspaceId, slug, sizeId) {
			// A snapshot may pause the machine; the next operation reads it fresh.
			forgetRunningGuest(workspaceId);
			try {
				// Only the disk: this runs while a chat waits for its copy, and
				// starting a desktop here would add its seconds to that wait.
				if (sizeId)
					await prepareTemplateSnapshot(freestyle.vms.ref(workspaceId), {
						storageMiB: machineSize(sizeId).storage,
					});
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

		boxToolIdentities: {
			mint: (workspaceId, linuxUser, record) =>
				mintBoxToolIdentity(freestyle.identities, {
					vmId: workspaceId,
					linuxUser,
					record,
				}),
			revoke: (identityId) =>
				revokeBoxToolIdentity(freestyle.identities, identityId),
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
							SCRUB_VM_TOKENS,
							30_000,
						);
						if (scrubbed.exitCode !== 0)
							throw new Error("the fork still holds the parent's tokens");
					},
					deleteVm: (vmId) => freestyle.vms.ref(vmId).delete(),
				});
				return { vm: WorkspaceId(fork.vmId), forkMs: fork.forkMs };
			} catch (cause) {
				if (cause instanceof WorkspaceProvisionError) throw cause;
				logMachineFailure({
					operation: "forkWorkspace",
					slug,
					vmId: source,
					error: cause,
				});
				throw new WorkspaceProvisionError({
					operation: "snapshot",
					message: providerMessage(cause),
					providerWorkspaceId: source,
					detail: machineFailureDetail(cause),
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
			// An earlier attempt made it (one a restart interrupted, a prewarm,
			// or one still running beside this one): finish and resume it.
			const adopt = async (existing: string) => {
				await completeCopiedMachineSize(freestyle.vms.ref(existing));
				// Its guest may never have answered.
				await resumeProductVm(
					freestyle.vms.ref(existing),
					"Agent session VM",
					60,
					undefined,
					true,
				);
				return WorkspaceId(existing);
			};
			const provision = async () => {
				const existing = await findVmBySlug(freestyle, slug);
				if (existing) return adopt(existing);
				const created = await createCopy().catch(async (cause) => {
					// Another attempt's create of this slug is still landing: the
					// provider refuses the slug before it lists the VM.
					if (machineFailureKind(cause) !== "conflict") throw cause;
					const landed = await waitForSlug(freestyle, slug);
					if (!landed) throw cause;
					return adopt(landed);
				});
				return created;
			};
			const createCopy = async () =>
				WorkspaceId(
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
								// The running read already carries the copy's resources.
								const current = (
									await waitUntilVmRunning(created.vm, "Agent session VM")
								).resources;
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
								await waitUntilGuestReady(fallback.vm, "Agent session VM");
								return fallback.vmId;
							}
							// After any resize: the copy's first command must find a guest that answers.
							await waitUntilGuestAnswers(created.vm, "Agent session VM");
							return created.vmId;
						},
						300,
						requestedResources,
					),
				);
			try {
				// Slug-keyed: a repeat finds and resumes a VM an earlier attempt
				// created, so passing failures are waited out, not surfaced.
				return await resumableMachineStart(provision, {
					operation: "provisionSession",
					slug,
				});
			} catch (cause) {
				throw new WorkspaceProvisionError({
					operation: "create",
					message: providerMessage(cause),
					detail: machineFailureDetail(cause),
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
/**
 * Polls for up to a minute for a resize the provider reported as failed:
 * soon at first (the resize is usually finishing as the gateway gives up),
 * then every 2 s.
 */
export async function resizeLands(
	vm: Pick<ReturnType<Freestyle["vms"]["ref"]>, "data">,
	target: { cpu: number; memory: number; storage: number },
	wait = (ms: number) =>
		new Promise<void>((resolve) => {
			setTimeout(resolve, ms);
		}),
	now = () => Date.now(),
) {
	const deadline = now() + RESIZE_LAND_WAIT_MS;
	for (let pause = 200; ; pause = Math.min(Math.round(pause * 1.5), 2_000)) {
		const resources = (await vm.data().catch(() => null))?.resources;
		if (
			resources &&
			resources.cpu >= target.cpu &&
			resources.memory >= target.memory &&
			resources.storage >= target.storage
		)
			return true;
		if (now() + pause > deadline) return false;
		await wait(pause);
	}
}
const RESIZE_LAND_WAIT_MS = 60_000;

/**
 * A chat's copy found by its slug before it was bound: one an earlier attempt
 * made. Tagged with the size it was made for but still smaller, its create or
 * resize answered with an error although the provider made it (seen on dev:
 * a create that failed in 166 ms left a copy behind), or its step was
 * interrupted while it grew. It holds no work yet, so it is grown to that
 * size now; it is never used undersized.
 */
async function completeCopiedMachineSize(
	vm: ReturnType<Freestyle["vms"]["ref"]>,
) {
	const data = await vm.data();
	if (!data.metadata?.machine_size) return;
	const requested = machineSize(
		machineSizeId.parse(data.metadata.machine_size),
	);
	const sized = (resources: typeof data.resources) =>
		resources.cpu >= requested.cpu &&
		resources.memory >= requested.memory &&
		resources.storage >= requested.storage;
	if (sized(data.resources)) return;
	const target = effectiveMachineResources(data.resources, requested);
	const grown = await vm.resize(target).then(
		() => true,
		// As at create: a 5xx often means the resize is still finishing.
		(error) =>
			error instanceof FreestyleApiError && error.status >= 500
				? resizeLands(vm, target)
				: false,
	);
	if (!grown)
		throw new Error(
			"Workspace sizing did not complete. The unbound machine needs recovery before it can be used.",
		);
	console.warn("Finished sizing a chat's unbound machine copy.", {
		requested: requested.id,
	});
}

async function resumeProductVm(
	vm: ReturnType<Freestyle["vms"]["ref"]>,
	label: string,
	requiredSeconds = 60,
	/** A read made just before; the admission re-reads under its lease anyway. */
	read?: VmData,
	/** Probe the guest even if it already reads as running. */
	probeGuest = false,
) {
	const data = read ?? (await vm.data());
	const admitted = await turnSpan("vm:admit", () =>
		admitVmResume(vm, data, requiredSeconds),
	);
	const lifecycle = productLifecycleUpdate(data);
	if (lifecycle) await vm.update(lifecycle).catch(() => undefined);
	if (data.state === "paused" || data.state === "stopped") {
		await turnSpan("vm:start", () => startAdmittedVm(vm, requiredSeconds));
	}
	// A machine that was not running yet has a guest that may not answer yet.
	if (probeGuest || data.state !== "running") {
		const ready = await turnSpan("vm:guestReady", () =>
			waitUntilGuestReady(vm, label),
		);
		// Its guest just answered: the next operations skip the provider read.
		rememberRunningGuest(ready);
		return ready;
	}
	// The admission read the running machine under its lease a moment ago
	// (and nothing changed its lifecycle since): reading it again tells nothing.
	if (!lifecycle && admitted?.state === "running") return admitted;
	return turnSpan("vm:waitRunning", () => waitUntilVmRunning(vm, label));
}

/** A running VM whose recent admission still covers the operation needs no new admission. */
function admittedAndRunning(data: VmData, requiredSeconds: number) {
	return (
		!productLifecycleUpdate(data) &&
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
	// Still booting (admission off): its guest may not answer the first call yet.
	if (data.state !== "running") return waitUntilGuestReady(vm, "Workspace VM");
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

/** How long a slug the provider refused as taken may take to be listed. */
const SLUG_LANDING_WAIT_MS = 30_000;

/** Waits for the VM another attempt is creating under this slug to be listed. */
async function waitForSlug(
	freestyle: Freestyle,
	slug: string,
	waitMs = SLUG_LANDING_WAIT_MS,
): Promise<string | null> {
	const deadline = Date.now() + waitMs;
	for (
		let pause = 250;
		Date.now() < deadline;
		pause = Math.min(pause * 2, 2_000)
	) {
		await new Promise((resolve) => setTimeout(resolve, pause));
		const found = await findVmBySlug(freestyle, slug).catch(() => null);
		if (found) return found;
	}
	return null;
}

async function findVmBySlug(
	freestyle: Freestyle,
	slug: string,
): Promise<string | null> {
	const { vms } = await freestyle.vms.list({ slug, limit: 1 });
	return vms[0]?.id ?? null;
}
