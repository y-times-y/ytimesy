import {
	alertHour,
	cronBlipNeedsAlert,
	cronBlipWindowMinutes,
	fleetBudgetAlerts,
} from "#/domain/owner-alerts";
import { captureServerException, redactErrorText } from "../adapters/analytics";
import { isWorkersRuntimeBlip } from "../adapters/freestyle/provider-retry";
import { fleetInfrastructureUsage } from "../adapters/infrastructure-usage";
import { alertOwner, recordCronBlip } from "../adapters/owner-alerts";

/** Emails the owner once the fleet's monthly or lifetime budget reaches 80% and 95%. */
export async function alertFleetBudget() {
	const usage = await fleetInfrastructureUsage().catch(() => null);
	if (!usage) return;
	for (const alert of fleetBudgetAlerts(usage)) await alertOwner(alert);
}

/** Turns whose worker stopped heartbeating and were failed by lease expiry. */
export async function alertAbandonedTurns(count: number, now = new Date()) {
	if (count <= 0) return;
	await alertOwner({
		kind: "abandoned-turns",
		key: alertHour(now),
		subject: `ytimesy: ${count} chat turn${count === 1 ? "" : "s"} abandoned`,
		text: `${count} running chat turn${count === 1 ? " was" : "s were"} failed because the worker stopped heartbeating (lease expiry). Users saw "The worker disconnected". Check executor logs and Durable Object errors. Further abandonments this hour are not emailed.`,
	});
}

/**
 * A scheduled maintenance job threw; the next tick retries it. A failure
 * that is the Workers runtime's own (isWorkersRuntimeBlip: a deploy swapping
 * versions) is only logged, unless the job keeps failing that way on later
 * runs (cronBlipNeedsAlert).
 */
export async function alertCronFailure(
	job: { kind: string; action?: string; everyMinutes?: number },
	error: unknown,
	now = new Date(),
	deps: { recordBlip?: typeof recordCronBlip } = {},
) {
	const name = job.action ? `${job.kind}:${job.action}` : job.kind;
	if (isWorkersRuntimeBlip(error)) {
		const everyMinutes = job.everyMinutes ?? 1;
		const episodeStartedAt = await (deps.recordBlip ?? recordCronBlip)(
			name,
			cronBlipWindowMinutes(everyMinutes),
		).catch(() => "unrecorded" as const);
		// Unrecorded (database unreachable): alerted as any failure is.
		if (
			episodeStartedAt !== "unrecorded" &&
			!cronBlipNeedsAlert({ episodeStartedAt, now, everyMinutes })
		) {
			console.warn(
				"Scheduled job hit a runtime blip; the next tick retries it.",
				{
					job: name,
					reason: redactErrorText(
						error instanceof Error ? error.message : String(error),
					).slice(0, 300),
				},
			);
			return;
		}
	}
	await captureServerException(error, {
		source: `cron:${name}`,
	});
	await alertOwner({
		kind: "cron-failure",
		key: `${name}:${alertHour(now)}`,
		subject: `ytimesy: scheduled job ${name} failed`,
		text: `The scheduled job ${name} failed (${error instanceof Error ? error.name : "unknown error"}). It is retried every tick; check the edge executor logs. Further failures of this job this hour are not emailed.${
			error instanceof Error && error.message
				? `\n\nReason: ${redactErrorText(error.message).slice(0, 500)}`
				: ""
		}`,
	});
}

/** Auth emails (verification, reset) that were given up on. */
export async function alertFailedEmails(count: number, now = new Date()) {
	if (count <= 0) return;
	await alertOwner({
		kind: "email-failed",
		key: alertHour(now),
		subject: `ytimesy: ${count} account email${count === 1 ? "" : "s"} failed`,
		text: `${count} verification or password-reset email${count === 1 ? " was" : "s were"} given up after retries (see auth_email_outbox.last_error). Those users cannot finish signing up or resetting until they request a new email. Check Cloudflare Email Sending.`,
	});
}
