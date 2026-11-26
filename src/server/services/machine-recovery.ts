import { MachineNotResponding } from "#/domain/api-turn-failure";
import type { WorkspaceId } from "#/domain/ids";
import {
	isMachineUnavailable,
	MACHINE_PROBE_DELAYS_MS,
	MACHINE_PROBE_TIMEOUT_MS,
	STALL_PROBE_AFTER_MS,
	STALL_PROBE_EVERY_MS,
	STALL_PROBES_TO_FAIL,
} from "#/domain/machine-health";
import type { WorkspaceMachines } from "./workspace-machines";

export type MachineRecoveryState = "recovering" | "recovered" | "failed";

export type MachineRecoveryOptions = {
	readonly signal?: AbortSignal;
	/** Tells the person: "Recovering…" while it lasts, nothing once it answers. */
	readonly onState?: (state: MachineRecoveryState, vm: WorkspaceId) => void;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Tests: the long-call watcher's own clock (defaults to sleep). */
	readonly watchSleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
};

const realSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The error that ends a call the machine never answered. */
class StalledMachineCall extends Error {
	constructor() {
		super("The workspace machine stopped answering.");
		this.name = "StalledMachineCall";
	}
}

/** A trivial command that proves the machine answers; never throws. */
async function probe(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
): Promise<boolean> {
	try {
		const result = await machines.exec(vm, "true", MACHINE_PROBE_TIMEOUT_MS);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Waits for a machine to answer again: resumes it if paused, then probes it
 * with backoff for MACHINE_PROBE_DELAYS_MS in all. True once it answers.
 */
export async function waitForMachine(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
	options: MachineRecoveryOptions = {},
): Promise<boolean> {
	const sleep = options.sleep ?? realSleep;
	for (let attempt = 0; attempt <= MACHINE_PROBE_DELAYS_MS.length; attempt++) {
		if (options.signal?.aborted) return false;
		await Promise.resolve(machines.ensureRunning?.(vm)).catch(() => undefined);
		if (await probe(machines, vm)) return true;
		const delay = MACHINE_PROBE_DELAYS_MS[attempt];
		if (delay === undefined) break;
		await sleep(delay);
	}
	return false;
}

const GUARDED = ["exec", "readTextFile", "writeTextFile", "readFile"] as const;
/** Reads can simply run again once the machine answers; a command or a write is left to the model, which sees the failure. */
const REPEATABLE = new Set<string>(["readTextFile", "readFile"]);

/**
 * `machines` whose guest calls survive a machine that is busy, restarting or
 * silent: a call that fails like one (or runs for minutes while the machine
 * no longer answers a probe) waits for the machine, with the person told
 * "Recovering…", instead of leaving the turn working in silence. A machine
 * that answers again hands the original failure to the model (reads run
 * again); one that stays silent fails the step as MachineNotResponding,
 * which the executor resumes from its checkpoint (turn-interruption.ts).
 */
export function recoveringMachines<M extends WorkspaceMachines>(
	machines: M,
	options: MachineRecoveryOptions = {},
): M {
	const now = options.now ?? Date.now;
	const recoveries = new Map<string, Promise<boolean>>();
	const recover = (vm: WorkspaceId) => {
		const running = recoveries.get(vm);
		if (running) return running;
		options.onState?.("recovering", vm);
		const attempt = waitForMachine(machines, vm, options)
			.catch(() => false)
			.then((healthy) => {
				options.onState?.(healthy ? "recovered" : "failed", vm);
				return healthy;
			})
			.finally(() => recoveries.delete(vm));
		recoveries.set(vm, attempt);
		return attempt;
	};
	/** Rejects once a call running for minutes sees the machine fail probes in a row. */
	const stallWatch = (vm: WorkspaceId, startedAt: number) => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const watchSleep = options.watchSleep ?? options.sleep;
		// The real wait is cleared the moment the call ends: no timer outlives a call.
		const pause = (ms: number) =>
			watchSleep
				? watchSleep(ms)
				: new Promise<void>((resolve) => {
						timer = setTimeout(resolve, ms);
					});
		const stalled = new Promise<never>((_, reject) => {
			void (async () => {
				let failures = 0;
				while (!stopped) {
					const wait = Math.max(
						STALL_PROBE_EVERY_MS,
						startedAt + STALL_PROBE_AFTER_MS - now(),
					);
					await pause(wait);
					if (stopped || options.signal?.aborted) return;
					if (now() - startedAt < STALL_PROBE_AFTER_MS) continue;
					failures = (await probe(machines, vm)) ? 0 : failures + 1;
					if (failures >= STALL_PROBES_TO_FAIL && !stopped)
						return reject(new StalledMachineCall());
				}
			})();
		});
		stalled.catch(() => undefined);
		return {
			stalled,
			stop: () => {
				stopped = true;
				clearTimeout(timer);
			},
		};
	};
	const wrapped: Record<string, unknown> = Object.fromEntries(
		Object.entries(machines),
	);
	for (const name of GUARDED) {
		const operation = machines[name] as
			| ((vm: WorkspaceId, ...rest: unknown[]) => Promise<unknown>)
			| undefined;
		if (typeof operation !== "function") continue;
		wrapped[name] = async (vm: WorkspaceId, ...rest: unknown[]) => {
			const run = () => operation.call(machines, vm, ...rest);
			const started = now();
			const first = run();
			const watch = name === "exec" ? stallWatch(vm, started) : null;
			try {
				return await (watch ? Promise.race([first, watch.stalled]) : first);
			} catch (error) {
				if (
					options.signal?.aborted ||
					!(isMachineUnavailable(error) || error instanceof StalledMachineCall)
				)
					throw error;
				if (!(await recover(vm))) throw new MachineNotResponding(error);
				if (REPEATABLE.has(name)) return await run();
				throw error instanceof StalledMachineCall
					? new Error(
							"The workspace machine stopped answering while this ran and has recovered. If this was a write, inspect its state before retrying; partial effects may exist.",
						)
					: error;
			} finally {
				watch?.stop();
			}
		};
	}
	return wrapped as M;
}
