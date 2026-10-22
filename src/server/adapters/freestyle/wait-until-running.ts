import { Effect } from "effect";
import type { Vm } from "freestyle";
import { WorkspaceProvisionError } from "#/server/services/errors";

class VmStillStarting extends Error {}

/** Freestyle can take over a minute to finish pausing an idle machine. */
const WAIT_SECONDS = 180;
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
	const read = Effect.tryPromise(() => vm.data()).pipe(
		Effect.flatMap((data) => {
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
	const deadline = Date.now() + WAIT_SECONDS * 1000;
	for (let pause = FIRST_PAUSE_MS; ; ) {
		const result = await Effect.runPromise(Effect.either(read), { signal });
		if (result._tag === "Right") return result.right;
		if (!(result.left instanceof VmStillStarting)) throw result.left;
		if (Date.now() + pause > deadline) break;
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
	throw new WorkspaceProvisionError({
		operation: "create",
		message: `${label} did not become running`,
		providerWorkspaceId: vm.id,
	});
}
