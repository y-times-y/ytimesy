import {
	isWorkspaceAtCapacity,
	isWorkspaceComputeAllowanceExhausted,
} from "./failure-message";

/** How long a chat's VM may keep refusing to start before the chat gets a new one. */
export const MACHINE_START_ABANDON_WINDOW_MS = 5 * 60_000;

/** Refusals needed before the window counts: one slow start is not a streak. */
export const MACHINE_START_ABANDON_MIN_FAILURES = 2;

/**
 * Whether a VM that has refused to start since `firstFailureAt` (null when
 * nothing is recorded) is given up on: it has failed at least
 * `minFailures` times over at least `windowMs`. Pure; the caller reads the
 * durable streak (machine_wake_failure) and decides what the failure was.
 */
export function machineStartAbandoned(input: {
	readonly firstFailureAt: Date | null;
	readonly now: Date;
	readonly windowMs?: number;
	readonly failures?: number;
	readonly minFailures?: number;
}) {
	if (!input.firstFailureAt) return false;
	if (
		input.failures !== undefined &&
		input.failures < (input.minFailures ?? MACHINE_START_ABANDON_MIN_FAILURES)
	)
		return false;
	return (
		input.now.getTime() - input.firstFailureAt.getTime() >=
		(input.windowMs ?? MACHINE_START_ABANDON_WINDOW_MS)
	);
}

/** Capacity limits and usage allowances are never fixed by a new VM. */
export function refusalIsNotAboutTheMachine(text: string) {
	return (
		isWorkspaceAtCapacity(text) || isWorkspaceComputeAllowanceExhausted(text)
	);
}
