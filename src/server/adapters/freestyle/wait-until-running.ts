import { Effect, Schedule } from "effect";
import type { Vm } from "freestyle";
import { WorkspaceProvisionError } from "#/server/services/errors";

class VmStillStarting extends Error {}

export async function waitUntilVmRunning(
	vm: Vm,
	label: string,
	signal?: AbortSignal,
) {
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
			return data.state === "running"
				? Effect.succeed(data)
				: Effect.fail(new VmStillStarting());
		}),
	);
	const result = await Effect.runPromise(
		read.pipe(
			Effect.retry({
				schedule: Schedule.intersect(
					Schedule.recurs(29),
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
