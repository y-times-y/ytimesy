export type OwnerAlertKind =
	| "fleet-budget"
	| "abandoned-turns"
	| "cron-failure"
	| "email-failed"
	| "codex-egress"
	| "chat-wake-failed"
	| "interruption"
	| "interruption-digest"
	| "canary-failed";

export type OwnerAlert = {
	readonly kind: OwnerAlertKind;
	/** One email per kind and key; put a time bucket in it to repeat later. */
	readonly key: string;
	readonly subject: string;
	readonly text: string;
};

/** UTC hour bucket for alert keys, e.g. 2026-10-19T09. */
export function alertHour(now = new Date()) {
	return now.toISOString().slice(0, 13);
}

/** Shares of a fleet cap that warn the owner, lowest first. */
export const FLEET_BUDGET_ALERT_SHARES = [0.8, 0.95] as const;

const dollars = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

/**
 * Alerts for the fleet's monthly and lifetime cloud budgets once usage
 * (consumed plus held) reaches 80% and 95%: only the highest threshold
 * crossed, keyed by month (monthly cap) or for good (lifetime cap).
 */
export function fleetBudgetAlerts(input: {
	period: string;
	monthlyUsedMicroUsd: number;
	monthlyCapMicroUsd: number;
	lifetimeUsedMicroUsd: number;
	lifetimeCapMicroUsd: number;
}): OwnerAlert[] {
	const alerts: OwnerAlert[] = [];
	for (const [scope, used, cap] of [
		["monthly", input.monthlyUsedMicroUsd, input.monthlyCapMicroUsd],
		["lifetime", input.lifetimeUsedMicroUsd, input.lifetimeCapMicroUsd],
	] as const) {
		if (!(cap > 0)) continue;
		const share = used / cap;
		const crossed = FLEET_BUDGET_ALERT_SHARES.filter((at) => share >= at).at(
			-1,
		);
		if (crossed === undefined) continue;
		const percent = Math.round(crossed * 100);
		alerts.push({
			kind: "fleet-budget",
			key: `${scope === "monthly" ? input.period : "lifetime"}:${scope}:${percent}`,
			subject: `ytimesy: fleet ${scope} cloud budget at ${Math.floor(share * 100)}%`,
			text: `The fleet ${scope} cloud budget has used ${dollars(used)} of ${dollars(cap)} (${Math.floor(share * 100)}%, consumed plus held). At 100% no machine can start for any user. Raise YTIMESY_FLEET_${scope === "monthly" ? "MONTHLY" : "LIFETIME"}_MICRO_USD or wait for the ${scope === "monthly" ? "month to reset" : "budget to be raised"}.`,
		});
	}
	return alerts;
}

/** What an operator does about each path; paths are configuration names, never URLs. */
const CODEX_PATH_REMEDY: Record<string, string> = {
	tunnel:
		"The tunnel is the AWS proxy (t4g.nano ytimesy-codex-proxy, us-east-2, Elastic IP, tcp/443; docs/research/codex-tunnel-production-2026-11-07.md): check the instance is running and its status checks pass, that the service is active and the Elastic IP is still attached, that OpenAI has not blocked the IP, and that YTIMESY_CODEX_TUNNEL_SIGNING_KEY on the Workers matches the proxy's public key. A refused credential and an unreachable host both read as transport.",
	vpc: "The Workers VPC network binding CODEX_EGRESS (Cloudflare Gateway egress): check the binding is on both production Workers and that OpenAI has not blocked Cloudflare's egress IPs.",
};
const remedyFor = (path: string) =>
	CODEX_PATH_REMEDY[path] ??
	"Check the relay host, its IP and its signing key (docs/research/codex-egress-failover-2026-10-20.md).";

/**
 * A Codex egress path started failing; later requests skip it for a cooldown.
 * `fallbacks` are the paths this request still had to try, in order: with
 * none, Codex subscription chats are failing right now.
 */
export function codexEgressBlockedAlert(
	path: string,
	reason: string,
	context: { fallbacks?: readonly string[]; detail?: string } = {},
	now = new Date(),
): OwnerAlert {
	const fallbacks = context.fallbacks ?? [];
	const state = fallbacks.length
		? `Codex chats are still being served: requests now use ${fallbacks.join(", then ")} and retry ${path} after a 5 minute cooldown. Nothing needs doing at once, but ${path} is down, so you are one failure from an outage.`
		: `No other path is configured, so Codex subscription chats are failing right now (each request retries ${path} every 5 minutes). Act now.`;
	return {
		kind: "codex-egress",
		key: `${path}:blocked:${alertHour(now)}`,
		subject: fallbacks.length
			? `ytimesy: Codex egress path ${path} blocked (${reason}); served by ${fallbacks[0]}`
			: `ytimesy: Codex chats failing: egress path ${path} blocked (${reason}), no fallback`,
		text: `The Codex subscription egress path ${path} was blocked (${reason}${context.detail ? `: ${context.detail}` : ""}). ${state}\n\nWhat to do: ${remedyFor(path)} To add a second independent path, configure a relay (YTIMESY_CODEX_RELAY_URL with its signing key). Further blocks of this path this hour are not emailed.\n\nAlert: codex-egress (${path}:blocked:${alertHour(now)})`,
	};
}

/** No configured egress path could reach the Codex backend. */
export function codexEgressExhaustedAlert(
	attempts: readonly { path: string; reason: string }[],
	now = new Date(),
): OwnerAlert {
	const tried = attempts.map((row) => `${row.path} (${row.reason})`).join(", ");
	return {
		kind: "codex-egress",
		key: `all:${alertHour(now)}`,
		subject: "ytimesy: Codex chats failing: every egress path is blocked",
		text: `No Codex subscription egress path could reach chatgpt.com: ${tried || "none configured"}. Codex subscription chats are failing right now (or failing over to another model where one is configured) until a path recovers; blocked paths are retried every 5 minutes.\n\nWhat to do: ${attempts.map((row) => `${row.path}: ${remedyFor(row.path)}`).join(" ")} Add or repair a relay (YTIMESY_CODEX_RELAY_URL_N with its signing key) for a second independent path. Further occurrences this hour are not emailed.`,
	};
}

/**
 * A deploy's blips land within a few minutes of each other (the edge and
 * the web Worker swap versions one after the other).
 */
export const CRON_BLIP_GRACE_MINUTES = 3;

/**
 * How long a scheduled job's runtime blip counts as the start of a failure
 * episode: two of the job's runs, and always longer than the grace, so a
 * job that keeps failing after the deploy is reached.
 */
export function cronBlipWindowMinutes(everyMinutes: number) {
	return Math.max(2 * everyMinutes, CRON_BLIP_GRACE_MINUTES + everyMinutes) + 1;
}

/**
 * Whether a scheduled job's runtime blip (a Workers "internal error", a Durable
 * Object reset for new code) is emailed, given when the job's current blip
 * episode began (null: none recorded). The first blip, and any within the
 * grace after it, are one deploy and only logged; a blip later in the same
 * episode means the job keeps failing, and is emailed like any failure.
 */
export function cronBlipNeedsAlert(input: {
	readonly episodeStartedAt: Date | null;
	readonly now: Date;
	readonly everyMinutes: number;
}) {
	if (!input.episodeStartedAt) return false;
	const minutes =
		(input.now.getTime() - input.episodeStartedAt.getTime()) / 60_000;
	return (
		minutes >= CRON_BLIP_GRACE_MINUTES &&
		minutes <= cronBlipWindowMinutes(input.everyMinutes)
	);
}
