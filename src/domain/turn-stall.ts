/**
 * The no-output watchdog (docs/interruption-proofing.md): a runner can keep
 * renewing a turn's heartbeat while it produces nothing (a hung Claude Code
 * process, a wedged box), so liveness cannot see it. A turn with no write
 * (stream delta, tool event, checkpoint) for this long is stalled.
 */
export const TURN_NO_OUTPUT_KIND = "turn-no-output";
/** Until the first output item of the turn. */
export const DEFAULT_FIRST_OUTPUT_STALL_SECONDS = 4 * 60;
/** Between output events once the turn has produced something. */
export const DEFAULT_OUTPUT_STALL_SECONDS = 10 * 60;

export type TurnStallLimits = {
	readonly firstOutputSeconds: number;
	readonly betweenOutputSeconds: number;
};

const seconds = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 60 && parsed <= 6 * 3600
		? Math.floor(parsed)
		: fallback;
};

/** YTIMESY_TURN_FIRST_OUTPUT_STALL_SECONDS and YTIMESY_TURN_OUTPUT_STALL_SECONDS (60 to 21600 s). */
export function turnStallLimits(
	env: Record<string, string | undefined>,
): TurnStallLimits {
	return {
		firstOutputSeconds: seconds(
			env.YTIMESY_TURN_FIRST_OUTPUT_STALL_SECONDS,
			DEFAULT_FIRST_OUTPUT_STALL_SECONDS,
		),
		betweenOutputSeconds: seconds(
			env.YTIMESY_TURN_OUTPUT_STALL_SECONDS,
			DEFAULT_OUTPUT_STALL_SECONDS,
		),
	};
}

/** Shown when the retry stalled too: calm, says the message is saved. */
export const STALLED_TURN_MESSAGE =
	"This turn stopped responding, and a second attempt did too. Your message is saved; send it again in a moment and it will run.";
