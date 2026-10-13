import { Effect, Schedule } from "effect";
import type { Vm } from "freestyle";
import { WorkspaceProvisionError } from "#/server/services/errors";

class VmStillStarting extends Error {}

/** Freestyle can take over a minute to finish pausing an idle machine. */
const WAIT_SECONDS = 180;

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
	const result = await Effect.runPromise(
		read.pipe(
			Effect.retry({
				schedule: Schedule.intersect(
					Schedule.recurs(WAIT_SECONDS - 1),
					Schedule.spaced("1 second"),
				),
				while: (cause) => cause instanceof VmStillStarting,
			}),
			Effect.either,
		),
		{ signal },
	);
	if (result._tag === "Right") return result.right;
	if (!(result.left instanceof VmStillStarting)) throw result.left;
	throw new WorkspaceProvisionError({
		operation: "create",
		message: `${label} did not become running`,
		providerWorkspaceId: vm.id,
	});
}
