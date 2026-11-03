import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * The abort signal of the machine call in progress. The provider adapter
 * aborts every request (polls included) made under it, so a Stop cancels
 * the in-flight HTTP call instead of waiting out its timeout.
 */
const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();

export function machineCallSignal(): AbortSignal | undefined {
	return callSignal.getStore();
}

/** Set inside work a turn starts and does not wait for (detachedFromTurn). */
const detached = new AsyncLocalStorage<true>();

/**
 * Runs work a turn starts without awaiting (starting the project's saved
 * services, warming the desktop) on plain machine calls: a Stop or the
 * turn's failure never cuts it off. Every machine call inside `work`, through
 * any cancellable view, runs as it would outside a turn.
 */
export function detachedFromTurn<T>(work: () => T): T {
	return detached.run(true, () => callSignal.run(undefined, work));
}

/** Settles with `work`, or rejects with the signal's reason once it aborts. */
function settleOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", stop));
	});
}

/**
 * One turn's view of `machines`: a call made while the turn is live rejects
 * as soon as the turn aborts, and its provider requests are aborted. A call
 * made after the abort (stopping the turn's commands, releasing ~/memory)
 * runs normally, so cleanup still reaches the VM. Only this turn's calls are
 * affected: other turns, background jobs and checkpoints use their own
 * objects, and a command already running on the VM is left to the turn's
 * own command stop.
 */
export function cancellableMachines<M extends WorkspaceMachines>(
	machines: M,
	signal: AbortSignal,
): M {
	const wrapped: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(machines)) {
		wrapped[name] =
			typeof value === "function"
				? (...args: unknown[]) => {
						const call = () =>
							(value as (...args: unknown[]) => unknown).apply(machines, args);
						if (signal.aborted || detached.getStore())
							return callSignal.run(undefined, call);
						const result = callSignal.run(signal, call);
						return result instanceof Promise
							? settleOnAbort(result, signal)
							: result;
					}
				: value;
	}
	return wrapped as M;
}
