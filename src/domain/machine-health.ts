/**
 * A chat's machine that answers 5xx (overloaded by a type-check, restarting,
 * its provider briefly down) or never answers must never leave a turn
 * "working" in silence (production 2026-11-25: chats d8d4f7c6 and c7494835,
 * 15 and 22 minutes; the machine's load average peaked at 7.4, every tool
 * call returned "Internal server error" and the Git handoff then failed).
 *
 * The turn's heartbeat keeps renewing while its tool call hangs, so liveness
 * cannot show this. Recovery therefore probes the machine itself:
 * - a tool call failing like this, or running longer than STALL_PROBE_AFTER_MS,
 *   starts a probe loop (a trivial command with a short timeout);
 * - the loop waits for the machine for MACHINE_PROBE_DELAYS_MS in all (about
 *   3 minutes), calmly telling the person "Recovering…";
 * - a machine that answers again lets the turn go on; one that does not makes
 *   the step fail as a transient infrastructure failure, which its executor
 *   resumes from the checkpoint for up to 15 minutes (turn-interruption.ts).
 */
export const STALL_PROBE_AFTER_MS = 3 * 60_000;
export const STALL_PROBE_EVERY_MS = 60_000;
/** Probes that must fail in a row before a long-running call counts as stalled. */
export const STALL_PROBES_TO_FAIL = 2;
export const MACHINE_PROBE_TIMEOUT_MS = 10_000;
export const MACHINE_PROBE_DELAYS_MS = [
	3_000, 6_000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000, 30_000,
] as const;

const UNAVAILABLE_TEXT =
	/internal server error|workspace request \(unavailable\)|bad gateway|service unavailable|gateway time-?out|econnreset|fetch failed|socket hang up|machine isn't responding/i;

/** True for the failures of a machine that is busy, restarting or unreachable. */
export function isMachineUnavailable(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const refused = error as { name?: unknown; status?: unknown };
	if (
		refused.name === "TurnBoxVmRefused" &&
		typeof refused.status === "number" &&
		refused.status >= 500
	)
		return true;
	if (refused.name === "MachineNotResponding") return true;
	return UNAVAILABLE_TEXT.test(error.message);
}

/** Notice shown while a machine is recovered; replaced by nothing once it answers. */
export const MACHINE_RECOVERING_NOTICE =
	"Recovering the workspace machine… It was busy or restarting. Your work is saved and this continues by itself.";

/** Whether a call that has run this long should be checked against the machine. */
export function shouldProbeLongCall(runningMs: number): boolean {
	return runningMs >= STALL_PROBE_AFTER_MS;
}

/** The exact total wait of one recovery, for tests and docs. */
export function totalProbeWaitMs(): number {
	return MACHINE_PROBE_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
}
