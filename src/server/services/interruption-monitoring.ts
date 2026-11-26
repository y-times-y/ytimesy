import { randomUUID } from "node:crypto";
import {
	CANARY_EVERY_MINUTES,
	canaryPrompts,
	canaryVerdict,
} from "#/domain/canary-timeline";
import {
	dailyInterruptionReport,
	type InterruptionEvent,
	interruptionDigestText,
	MACHINE_FAILURE_TARGET_PER_1000,
	MACHINE_START_FAILED_KIND,
	machineFailureRateExceeded,
	utcDay,
} from "#/domain/interruption-report";
import { alertHour } from "#/domain/owner-alerts";
import type { SessionItem } from "#/domain/session-item";
import {
	canaryCountsSince,
	canarySessionItems,
	finishCanaryRun,
	interruptionRowsSince,
	lastCanarySession,
	pendingCanaryRun,
	pruneInterruptionHistory,
	recordInterruption,
	startCanaryRun,
	turnsCreatedOnDay,
} from "../adapters/interruption-events";
import { alertOwner } from "../adapters/owner-alerts";

/**
 * The one entry point for code that notices an interruption of a chat turn
 * (turn.interrupted, lease takeover, abandoned turn, restored queued message,
 * delayed start). Records a row (bounded, best effort) and, when the user saw
 * it, emails the owner once per hour. Never throws and never waits long:
 * bookkeeping does not fail or slow the action it describes.
 */
export async function reportInterruption(
	event: InterruptionEvent,
	deps: {
		record?: typeof recordInterruption;
		alert?: typeof alertOwner;
		now?: Date;
	} = {},
): Promise<void> {
	try {
		const outcome = await (deps.record ?? recordInterruption)(event);
		// "limited": an earlier row for this turn stands and alerted already.
		if (!event.userVisible || outcome === "limited") return;
		await (deps.alert ?? alertOwner)({
			kind: "interruption",
			key: alertHour(deps.now),
			subject: "ytimesy: a user saw a chat turn interrupted",
			text: `A chat turn was interrupted in a way the user could see (${event.kind}, cause: ${event.cause ?? "unknown"}, turn ${event.turnId ?? "unknown"}, recovered: ${event.recovered ? "yes" : "no"}). Check the edge and box logs for turn.interrupted around this time and any deploy. Further user-visible interruptions this hour are not emailed; the daily digest counts them all.`,
		});
	} catch {
		console.warn("Interruption report failed.", { kind: event.kind });
	}
}

/** UTC hour the daily digest goes out (the first tick of it). */
export const DIGEST_HOUR_UTC = 7;

/** Yesterday's counts, once a day (the owner_alert row is the claim). */
export async function sendInterruptionDigest(
	now = new Date(),
	deps: {
		rows?: typeof interruptionRowsSince;
		canary?: typeof canaryCountsSince;
		alert?: typeof alertOwner;
		prune?: typeof pruneInterruptionHistory;
		turns?: (day: string) => Promise<number>;
	} = {},
) {
	const day = utcDay(new Date(now.getTime() - 24 * 3_600_000));
	const rows = await (deps.rows ?? interruptionRowsSince)(8);
	const days = dailyInterruptionReport(rows);
	const canary = await (deps.canary ?? canaryCountsSince)(1).catch(
		() => undefined,
	);
	const found = days.find((entry) => entry.day === day);
	const machineFailures = rows.filter(
		(row) =>
			row.kind === MACHINE_START_FAILED_KIND &&
			row.user_visible &&
			utcDay(row.at) === day,
	).length;
	const turns = await (deps.turns ?? turnsCreatedOnDay)(day).catch(() => 0);
	const machine = { turns, machineFailures };
	if (machineFailureRateExceeded(machineFailures, turns))
		await (deps.alert ?? alertOwner)({
			kind: "machine-failure-rate",
			key: day,
			subject: `ytimesy: machine start failures above target on ${day} (${machineFailures} of ${turns} turns)`,
			text: `Users saw ${machineFailures} machine start failures in ${turns} turns on ${day}; the target is under ${MACHINE_FAILURE_TARGET_PER_1000} per 1,000. See interruption_event kind ${MACHINE_START_FAILED_KIND} and the machine-start-retry rows for the cause.`,
		}).catch(() => undefined);
	await (deps.alert ?? alertOwner)({
		kind: "interruption-digest",
		key: day,
		subject: `ytimesy: ${found?.total ?? 0} interruptions on ${day} (${found?.userVisible ?? 0} user-visible)`,
		text: interruptionDigestText(days, day, canary, rows, machine),
	});
	await (deps.prune ?? pruneInterruptionHistory)().catch(() => undefined);
}

/** The synthetic account the canary signs in as. Unset: the canary is inert. */
export type CanaryConfig = {
	readonly userId: string;
	readonly projectId: string;
	readonly modelId: string;
};

export function canaryConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
): CanaryConfig | null {
	const userId = env.YTIMESY_CANARY_USER_ID?.trim();
	const projectId = env.YTIMESY_CANARY_PROJECT_ID?.trim();
	const modelId = env.YTIMESY_CANARY_MODEL_ID?.trim();
	return userId && projectId && modelId ? { userId, projectId, modelId } : null;
}

/** A canary chat longer than this is replaced by a fresh one. */
const CANARY_CHAT_MAX_ITEMS = 200;

export type CanaryDeps = {
	readonly config: CanaryConfig;
	/** Sends one message as the canary user; the chat's id (createNew when null). */
	readonly send: (text: string, sessionId: string | null) => Promise<string>;
	readonly items?: typeof canarySessionItems;
	readonly pending?: typeof pendingCanaryRun;
	readonly start?: typeof startCanaryRun;
	readonly finish?: typeof finishCanaryRun;
	readonly lastSession?: typeof lastCanarySession;
	readonly alert?: typeof alertOwner;
	readonly nonce?: () => string;
};

/**
 * One canary step, run on a cron tick; it never waits on the model.
 * - A run waiting for its answers is checked: passed, failed (alerting the
 *   owner) or left for the next tick.
 * - Otherwise, on the half hour, a new run sends A and, at once, B (which
 *   queues behind A's running turn) into the canary's own chat, which has
 *   idled since the last run, so the send also wakes it.
 */
export async function runCanaryStep(
	now: Date,
	deps: CanaryDeps,
): Promise<"idle" | "sent" | "pending" | "passed" | "failed"> {
	const { config } = deps;
	const pendingRun = await (deps.pending ?? pendingCanaryRun)();
	if (pendingRun) {
		const items =
			(await (deps.items ?? canarySessionItems)(
				config.userId,
				pendingRun.sessionId,
			)) ?? ([] as SessionItem[]);
		const verdict = canaryVerdict(items, {
			nonce: pendingRun.nonce,
			baselineItems: pendingRun.baselineItems,
			elapsedMs: now.getTime() - pendingRun.at.getTime(),
		});
		if (verdict.status === "pending") return "pending";
		if (verdict.status === "pass") {
			await (deps.finish ?? finishCanaryRun)(pendingRun.id, null);
			return "passed";
		}
		await (deps.finish ?? finishCanaryRun)(pendingRun.id, verdict.reason);
		await (deps.alert ?? alertOwner)({
			kind: "canary-failed",
			key: alertHour(now),
			subject: "ytimesy: the synthetic canary chat failed",
			text: `The canary (send, turn, wake, queued second message) failed: ${verdict.reason}. Chat ${pendingRun.sessionId} of the synthetic account. Real chats may be affected: check recent turn.interrupted lines and deploys. Further failures this hour are not emailed.`,
		});
		return "failed";
	}
	if (Math.floor(now.getTime() / 60_000) % CANARY_EVERY_MINUTES !== 0)
		return "idle";
	const known = await (deps.lastSession ?? lastCanarySession)();
	const held = known
		? await (deps.items ?? canarySessionItems)(config.userId, known)
		: null;
	const reuse = held && held.length < CANARY_CHAT_MAX_ITEMS ? known : null;
	const nonce = (deps.nonce ?? (() => randomUUID().slice(0, 8)))();
	const prompts = canaryPrompts(nonce);
	const sessionId = await deps.send(prompts.first, reuse);
	await deps.send(prompts.second, sessionId);
	await (deps.start ?? startCanaryRun)({
		sessionId,
		nonce,
		baselineItems: reuse ? (held?.length ?? 0) : 0,
	});
	return "sent";
}

/**
 * Called from the existing every-5-minutes maintenance tick (no Worker cron
 * of its own): the digest once a day at DIGEST_HOUR_UTC, the canary when
 * configured. Failures are logged and never fail the tick.
 */
export async function runInterruptionMonitoring(
	now: Date,
	canary: CanaryDeps | null,
	deps: {
		digest?: typeof sendInterruptionDigest;
		step?: typeof runCanaryStep;
	} = {},
) {
	if (now.getUTCHours() === DIGEST_HOUR_UTC && now.getUTCMinutes() < 5)
		await (deps.digest ?? sendInterruptionDigest)(now).catch((error: unknown) =>
			console.warn("Interruption digest failed.", {
				message: error instanceof Error ? error.message.slice(0, 200) : "",
			}),
		);
	if (canary)
		await (deps.step ?? runCanaryStep)(now, canary).catch((error: unknown) =>
			console.warn("Canary step failed.", {
				message: error instanceof Error ? error.message.slice(0, 200) : "",
			}),
		);
}
