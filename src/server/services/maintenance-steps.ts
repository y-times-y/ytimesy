import { FreestyleApiError } from "freestyle";
import { redactErrorText } from "../adapters/analytics";
import { RecycleDeferred } from "../adapters/freestyle/workspace-retention";

export type MaintenanceStep = {
	readonly name: string;
	readonly run: () => Promise<unknown>;
};

/** One or more steps of a maintenance job failed in a way a human should look at. */
export class MaintenanceStepsFailed extends Error {
	override name = "MaintenanceStepsFailed";
	/** Each failed step's error, in step order; the first is also `cause`. */
	readonly errors: readonly unknown[];
	constructor(
		readonly job: string,
		readonly steps: readonly string[],
		errors: readonly unknown[],
	) {
		const cause = errors[0];
		super(
			`${job}: ${steps.join(", ")} failed (${errorSummary(cause).slice(0, 300)})`,
			{ cause },
		);
		this.errors = errors;
	}
}

/**
 * Failures the next tick resolves on its own: a deliberate deferral, a VM
 * that is already gone (404), or a transient provider answer (429, 5xx and
 * this client's own provider timeout, shaped as 504, or Freestyle refusing
 * to place a VM while its host recovers capacity).
 */
export function maintenanceFailureNeedsHuman(error: unknown) {
	if (error instanceof RecycleDeferred) return false;
	if (error instanceof FreestyleApiError)
		return !(
			error.status === 404 ||
			error.status === 429 ||
			error.status >= 500 ||
			PLACEMENT_REJECTED.test(error.message)
		);
	return true;
}

/** "placement rejected: shared memory pool is recovering from allocation stalls" (2026-11-03). */
const PLACEMENT_REJECTED = /\bplacement rejected\b/i;

/**
 * Runs every step, even after one fails, and logs each failure with its step
 * name and a redacted reason. Throws once at the end, and only when a failure
 * needs a human, so a deferral never raises an alert.
 */
export async function runMaintenanceSteps(
	job: string,
	steps: readonly MaintenanceStep[],
) {
	const failed: string[] = [];
	const errors: unknown[] = [];
	for (const step of steps)
		try {
			await step.run();
		} catch (error) {
			const needsHuman = maintenanceFailureNeedsHuman(error);
			const log = needsHuman ? console.error : console.warn;
			log("Maintenance step failed.", {
				job,
				step: step.name,
				needsHuman,
				reason: redactErrorText(errorSummary(error)).slice(0, 500),
			});
			if (!needsHuman) continue;
			failed.push(step.name);
			errors.push(error);
		}
	if (failed.length) throw new MaintenanceStepsFailed(job, failed, errors);
}

function errorSummary(error: unknown) {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}
