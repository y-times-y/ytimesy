import { redactErrorText } from "./analytics";
import { database } from "./database";
import { alertOwner } from "./owner-alerts";

/** Consecutive refusals within this window count toward the alert. */
const WINDOW_MINUTES = 60;
/** The refusal that emails the owner (once per VM per window). */
export const WAKE_FAILURE_ALERT_AT = 3;

/**
 * A chat's VM refused to wake (a failure the retry loop gave up on). Counts
 * consecutive refusals per VM; the third within an hour emails the owner, so
 * a chat stuck for good is found before a user reports it. Never throws: it
 * must not turn a wake failure into a different one (AGENTS.md).
 */
export async function recordWakeFailure(vmId: string, cause: unknown) {
	try {
		const detail = redactErrorText(
			cause instanceof Error ? cause.message : String(cause),
		).slice(0, 300);
		const result = await database().query<{ failures: number }>(
			`insert into machine_wake_failure(vm_id,last_detail) values($1,$2)
			 on conflict (vm_id) do update set
			   failures = case when machine_wake_failure.last_at < now() - $3::int * interval '1 minute'
			                   then 1 else machine_wake_failure.failures + 1 end,
			   first_at = case when machine_wake_failure.last_at < now() - $3::int * interval '1 minute'
			                   then now() else machine_wake_failure.first_at end,
			   last_at = now(), last_detail = excluded.last_detail
			 returning failures`,
			[vmId, detail, WINDOW_MINUTES],
		);
		if (result.rows[0]?.failures !== WAKE_FAILURE_ALERT_AT) return;
		await alertOwner({
			kind: "chat-wake-failed",
			key: `${vmId}:${new Date().toISOString().slice(0, 13)}`,
			subject: "ytimesy: a chat's machine keeps failing to wake",
			text: `VM ${vmId} refused to start ${WAKE_FAILURE_ALERT_AT} times in a row within ${WINDOW_MINUTES} minutes, so its chat cannot continue (new chats are unaffected). Last reason: ${detail || "unknown"}. Check the edge logs for "Machine operation failed" with this vmId.`,
		});
	} catch {
		console.warn("Wake failure could not be recorded.", { vmId });
	}
}

/** A successful wake ends the streak. Never throws. */
export async function clearWakeFailures(vmId: string) {
	try {
		await database().query("delete from machine_wake_failure where vm_id=$1", [
			vmId,
		]);
	} catch {
		/* the next failure starts a fresh streak after the window anyway */
	}
}

/** The current streak of refusals for a VM (see recordWakeFailure). */
export type WakeFailureStreak = {
	readonly failures: number;
	readonly firstAt: Date;
	readonly lastAt: Date;
};

/**
 * How long this VM has been refusing to wake, or null when it is not (or
 * the read failed: a bookkeeping failure never decides to replace a VM, and
 * never fails the turn). Durable, so a turn resumed on another Durable
 * Object sees the same streak.
 */
export async function readWakeFailureStreak(
	vmId: string,
): Promise<WakeFailureStreak | null> {
	try {
		const result = await database().query<{
			failures: number;
			first_at: Date;
			last_at: Date;
		}>(
			"select failures,first_at,last_at from machine_wake_failure where vm_id=$1",
			[vmId],
		);
		const row = result.rows[0];
		return row
			? {
					failures: row.failures,
					firstAt: new Date(row.first_at),
					lastAt: new Date(row.last_at),
				}
			: null;
	} catch {
		return null;
	}
}
