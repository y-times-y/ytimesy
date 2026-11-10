import { Effect } from "effect";
import type { Vm } from "freestyle";
import { WorkspaceProvisionError } from "#/server/services/errors";
import { providerTimeoutError } from "./bounded-fetch";
import {
	isTransientProviderFailure,
	retryTransientProviderFailure,
} from "./provider-retry";

class VmStillStarting extends Error {}

/**
 * What a wait saw, logged when it ends without a running machine. The
 * provider keeps no history of a machine's states, so without this the cause
 * of "did not become running" cannot be recovered afterwards.
 */
class VmWaitTrace {
	private readonly states = new Map<string, number>();
	private readonly startedAt = Date.now();
	private lastData: Record<string, unknown> = {};
	private startFailure: string | null = null;
	constructor(private readonly vmId: string) {}
	observe(data: object) {
		const state = String((data as { state?: unknown }).state);
		this.states.set(state, (this.states.get(state) ?? 0) + 1);
		this.lastData = data as Record<string, unknown>;
	}
	startFailed(error: unknown) {
		const { status, code, requestId } = error as {
			status?: unknown;
			code?: unknown;
			requestId?: unknown;
		};
		this.startFailure = JSON.stringify({
			message: error instanceof Error ? error.message.slice(0, 200) : "?",
			status,
			code,
			requestId,
		});
	}
	log(outcome: string) {
		try {
			const data = this.lastData;
			console.warn(
				JSON.stringify({
					event: "vm.wait_failed",
					outcome,
					vmId: this.vmId,
					waitedMs: Date.now() - this.startedAt,
					statesSeen: Object.fromEntries(this.states),
					lastState: data.state,
					totalRunSeconds: data.totalRunSeconds,
					maxRunTotalSeconds: data.maxRunTotalSeconds,
					maxRunSeconds: data.maxRunSeconds,
					idleTimeoutSeconds: data.idleTimeoutSeconds,
					automaticRestart: data.automaticRestart,
					startFailure: this.startFailure,
				}),
			);
		} catch {
			// Bookkeeping only.
		}
	}
}

/** Freestyle can take over a minute to finish pausing an idle machine. */
const PAUSING_WAIT_SECONDS = 180;
/**
 * A machine that was asked to start is normally running within seconds. One
 * still "starting" after this long is stuck, so the start is asked for again
 * and, past the limit, the wait ends instead of holding the user for minutes.
 */
const STARTING_REISSUE_SECONDS = 30;
const MAX_START_REISSUES = 2;
const STARTING_WAIT_SECONDS = 90;
/** A machine that reads stopped is started again this many times before giving up. */
const MAX_STOPPED_RESTARTS = 1;
/**
 * A started or resumed machine is usually running within a second: the first
 * reads come quickly, then once a second for a slow one.
 */
const FIRST_PAUSE_MS = 200;
const MAX_PAUSE_MS = 1_000;

/**
 * Waits for a machine the caller wants running. A machine caught mid-pause
 * (idle timeout) cannot be started until the pause completes, so once it
 * settles as paused it is started here instead of timing out.
 */
export async function waitUntilVmRunning(
	vm: Vm,
	label: string,
	signal?: AbortSignal,
) {
	let started = false;
	let restartedFromStopped = 0;
	let reissued = 0;
	const waitStarted = Date.now();
	let startingSince: number | null = null;
	let sawPausing = false;
	const trace = new VmWaitTrace(vm.id);
	const read = Effect.tryPromise(() => vm.data()).pipe(
		Effect.tap((data) => Effect.sync(() => trace.observe(data))),
		Effect.flatMap((data) => {
			if (data.state === "starting") {
				startingSince ??= Date.now();
				if (
					reissued < MAX_START_REISSUES &&
					Date.now() - startingSince >= STARTING_REISSUE_SECONDS * 1000
				) {
					reissued++;
					startingSince = Date.now();
					return Effect.tryPromise(() => vm.start()).pipe(
						Effect.tapError((error) =>
							Effect.sync(() => trace.startFailed(error)),
						),
						Effect.catchAll(() => Effect.void),
						Effect.flatMap(() => Effect.fail(new VmStillStarting())),
					);
				}
				return Effect.fail(new VmStillStarting());
			}
			startingSince = null;
			if (data.state === "pausing") sawPausing = true;
			if (
				data.state === "stopped" &&
				restartedFromStopped < MAX_STOPPED_RESTARTS
			) {
				restartedFromStopped++;
				return Effect.tryPromise(() => vm.start()).pipe(
					Effect.catchAll(() => Effect.void),
					Effect.flatMap(() => Effect.fail(new VmStillStarting())),
				);
			}
			if (data.state === "stopped") {
				return Effect.fail(
					new WorkspaceProvisionError({
						operation: "create",
						message: `${label} stopped before it became running`,
						providerWorkspaceId: vm.id,
					}),
				);
			}
			if (data.state === "running") return Effect.succeed(data);
			if (data.state === "paused" && !started) {
				started = true;
				return Effect.tryPromise(() => vm.start()).pipe(
					Effect.catchAll(() => Effect.void),
					Effect.flatMap(() => Effect.fail(new VmStillStarting())),
				);
			}
			return Effect.fail(new VmStillStarting());
		}),
	);
	// A machine that only ever read as starting is stuck, not slow: end its
	// wait early. One that was pausing keeps the long wait.
	const deadline = () =>
		waitStarted +
		(sawPausing ? PAUSING_WAIT_SECONDS : STARTING_WAIT_SECONDS) * 1000;
	for (let pause = FIRST_PAUSE_MS; ; ) {
		const result = await Effect.runPromise(Effect.either(read), { signal });
		if (result._tag === "Right") return result.right;
		if (!(result.left instanceof VmStillStarting)) {
			trace.log("stopped");
			throw result.left;
		}
		if (Date.now() + pause > deadline()) break;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(done, pause);
			function done() {
				signal?.removeEventListener("abort", stop);
				resolve();
			}
			function stop() {
				clearTimeout(timer);
				reject(signal?.reason);
			}
			if (signal?.aborted) stop();
			else signal?.addEventListener("abort", stop, { once: true });
		});
		pause = Math.min(Math.round(pause * 1.5), MAX_PAUSE_MS);
	}
	trace.log("deadline");
	throw new WorkspaceProvisionError({
		operation: "create",
		message: `${label} did not become running`,
		providerWorkspaceId: vm.id,
	});
}

/** Backoff between probes of a guest that just started (about 15 s in all). */
export const GUEST_PROBE_RETRY_DELAYS_MS = [
	1_000, 2_000, 4_000, 8_000,
] as const;
/** A probe is `true`; one that takes this long hit a guest that is not answering. */
const GUEST_PROBE_MS = 20_000;

/**
 * A just-started VM reads as running before its guest answers: the first
 * exec could fail with "fetch failed" or hang until the provider gave up. A
 * harmless command (repeating it cannot matter) is retried until the guest
 * answers, so the caller's own first command, which is never repeated, runs
 * on a guest known to answer.
 */
export async function waitUntilGuestAnswers(
	vm: Pick<Vm, "id" | "exec">,
	label: string,
	delaysMs: readonly number[] = GUEST_PROBE_RETRY_DELAYS_MS,
	probeMs = GUEST_PROBE_MS,
) {
	try {
		await retryTransientProviderFailure(async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				// An abandoned probe keeps polling only until the client's own bound.
				await Promise.race([
					vm.exec({ command: "true", timeoutMs: 10_000 }),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(providerTimeoutError("exec probe")),
							probeMs,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		}, delaysMs);
	} catch (cause) {
		if (!isTransientProviderFailure(cause)) throw cause;
		throw new WorkspaceProvisionError({
			operation: "create",
			message: `${label} started but is not answering yet. Try again in a minute.`,
			providerWorkspaceId: vm.id,
		});
	}
}

/** Waits until the VM is running and its guest answers a command. */
export async function waitUntilGuestReady(
	vm: Vm,
	label: string,
	signal?: AbortSignal,
) {
	const data = await waitUntilVmRunning(vm, label, signal);
	await waitUntilGuestAnswers(vm, label);
	return data;
}
