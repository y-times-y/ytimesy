import { MachineNotResponding, TURN_NOT_STARTED } from "./api-turn-failure";
import { CoordinationFailure } from "./conversation-turn-control";

/**
 * The rules that keep infrastructure trouble away from the person (docs/interruption-proofing.md):
 *
 * - a step that fails for an infrastructure reason (the chat's coordinator or
 *   the edge did not answer, a lease renewal timed out, the chat was still
 *   busy) is never settled as failed: it is resumed from its checkpoint,
 *   by its executor, with backoff, for TRANSIENT_RETRY_WINDOW_MS;
 * - any other failing step is resumed GENUINE_STEP_RETRIES times, as before;
 * - the person's own Stop is never retried.
 */
export const TRANSIENT_RETRY_WINDOW_MS = 15 * 60_000;
export const GENUINE_STEP_RETRIES = 3;
/** A turn that has failed this many times in a row is not infrastructure trouble, whatever the clock says. */
export const MAX_TRANSIENT_ATTEMPTS = 40;
const BACKOFF_STEP_MS = 5_000;
const BACKOFF_CAP_MS = 60_000;

/** Reasons a turn's own heartbeat aborts it that are about infrastructure, not the person. */
const TRANSIENT_ABORT_MESSAGES = new Set([
	"Turn heartbeat or coordination service became unavailable.",
	"Conversation coordination lease was lost.",
	"Conversation coordination lease was lost before completion.",
]);

/**
 * The edge answered a box's workspace request 5xx: the machine provider or
 * the edge was briefly unavailable (2026-11-22/23: 4 box turns failed this way).
 */
export function isEdgeOutage(error: unknown) {
	const refused = error as { name?: unknown; status?: unknown } | null;
	return (
		refused?.name === "TurnBoxVmRefused" &&
		typeof refused.status === "number" &&
		refused.status >= 500
	);
}

/**
 * The machine could not start because the provider's account limit, its
 * request limit or our own hourly creation count was hit. All pass as other
 * machines pause or the hour turns, so the step waits and resumes (calm
 * "Starting machine" status) instead of failing the turn.
 */
const MACHINE_REFUSAL_THAT_PASSES =
	/limiting requests|LIMIT_EXCEEDED|too many new machines|resource limit exceeded/i;

export function isMachineRefusalThatPasses(cause: unknown, depth = 0): boolean {
	if (depth > 4 || !(cause instanceof Error)) return false;
	const tag = (cause as { _tag?: unknown })._tag;
	if (
		cause.name === "WorkspaceProvisionError" ||
		tag === "WorkspaceProvisionError"
	) {
		const detail = String((cause as { detail?: unknown }).detail ?? "");
		return MACHINE_REFUSAL_THAT_PASSES.test(`${cause.message} ${detail}`);
	}
	return isMachineRefusalThatPasses(cause.cause, depth + 1);
}

/** True when retrying the step from its checkpoint is the right answer, whatever the person did not do. */
export function isTransientInfrastructureFailure(cause: unknown): boolean {
	if (cause instanceof CoordinationFailure) return cause.retryable;
	// A chat machine that stayed down through a whole recovery: resumed, not failed.
	if (cause instanceof MachineNotResponding) return true;
	if (cause instanceof Error)
		return (
			cause.message === TURN_NOT_STARTED ||
			TRANSIENT_ABORT_MESSAGES.has(cause.message) ||
			isMachineRefusalThatPasses(cause)
		);
	return false;
}

/** Wait before the n-th (1-based) consecutive retry: 5 s, 10 s, 20 s, 40 s, then 60 s. */
export function stepRetryDelayMs(attempt: number): number {
	const exponent = Math.max(0, Math.min(attempt - 1, 10));
	return Math.min(BACKOFF_STEP_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

/**
 * Whether a step that just failed should run again. `firstFailureAt` is when
 * the current run of consecutive failures began; `failures` counts them.
 */
export function shouldRetryStep(input: {
	transient: boolean;
	failures: number;
	firstFailureAt: number;
	now: number;
}): boolean {
	if (input.transient)
		return (
			input.failures < MAX_TRANSIENT_ATTEMPTS &&
			input.now - input.firstFailureAt < TRANSIENT_RETRY_WINDOW_MS
		);
	return input.failures <= GENUINE_STEP_RETRIES;
}
