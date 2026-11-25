import { machineFailureKind } from "../adapters/freestyle/machine-failure";

export const ENVIRONMENT_MACHINE_AT_CAPACITY =
	"The machine provider is at capacity right now, so the environment could not start. Your repositories are fine; retry in a few minutes.";
export const ENVIRONMENT_MACHINE_NOT_STARTED =
	"The environment machine could not be started. Your repositories were not touched; retry in a minute.";

/**
 * The build's machine could not be started. Its message is the one shown to
 * the person (the provider's own text is not); `cause` keeps the raw failure
 * for the logs.
 */
export class EnvironmentMachineFailure extends Error {
	constructor(
		message: string,
		readonly cause: unknown,
	) {
		super(message);
		this.name = "EnvironmentMachineFailure";
	}
}

export function environmentMachineFailure(
	cause: unknown,
): EnvironmentMachineFailure {
	if (cause instanceof EnvironmentMachineFailure) return cause;
	const kind = machineFailureKind(cause);
	const atCapacity = kind === "rate-limited" || kind === "quota";
	return new EnvironmentMachineFailure(
		atCapacity
			? ENVIRONMENT_MACHINE_AT_CAPACITY
			: ENVIRONMENT_MACHINE_NOT_STARTED,
		cause,
	);
}
