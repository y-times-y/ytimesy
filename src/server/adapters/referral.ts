import { createHmac, randomBytes } from "node:crypto";
import {
	decideReferral,
	GRANT_DELAY_MINUTES,
	NETWORK_SIGNUPS_PER_DAY,
	networkPrefix,
	normalizeEmail,
	REFERRER_PERIOD_DAYS,
	REFERRER_REWARDS_LIFETIME,
	REFERRER_REWARDS_PER_PERIOD,
	referralCodeFromBytes,
	userAgentFamily,
} from "#/domain/referral";
import { database } from "./database";
import {
	redeemReferralResetIfBlocked,
	withUsageLock,
} from "./infrastructure-usage";

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTLE_BATCH = 50;

/** Salted, one-way: a key says "the same as" and nothing else. */
function key(purpose: string, value: string) {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("BETTER_AUTH_SECRET must be configured.");
	return createHmac("sha256", `${secret}:referral:${purpose}`)
		.update(value)
		.digest("hex")
		.slice(0, 40);
}
const emailKey = (email: string) => key("email", normalizeEmail(email));
function networkKey(
	ip: string | null | undefined,
	userAgent: string | null | undefined,
) {
	const prefix = networkPrefix(ip);
	return prefix
		? key("network", `${prefix}|${userAgentFamily(userAgent)}`)
		: null;
}

/** The kill switch: the environment variable or the operator's row turns referral off. */
export async function referralEnabled() {
	if (process.env.YTIMESY_REFERRAL_DISABLED === "1") return false;
	const result = await database().query<{ enabled: boolean }>(
		"select enabled from referral_config where singleton",
	);
	return result.rows[0]?.enabled !== false;
}

export async function setReferralEnabled(enabled: boolean) {
	await database().query(
		"insert into referral_config(singleton,enabled) values(true,$1) on conflict(singleton) do update set enabled=excluded.enabled,updated_at=now()",
		[enabled],
	);
}

/** The account's personal code, created on first use. */
export async function ensureReferralCode(userId: string): Promise<string> {
	const db = database();
	for (let attempt = 0; attempt < 5; attempt++) {
		const existing = await db.query<{ code: string }>(
			"select code from referral_code where user_id=$1",
			[userId],
		);
		if (existing.rows[0]) return existing.rows[0].code;
		const code = referralCodeFromBytes(randomBytes(8));
		await db.query(
			"insert into referral_code(user_id,code) values($1,$2) on conflict do nothing",
			[userId, code],
		);
	}
	throw new Error("Could not create a referral code.");
}

export type Attribution = "attributed" | "disabled" | "unknown_code" | "self";

/**
 * Records that a new account came through a code. Never rewards anything: the
 * reward waits for the referred account's first completed turn (settleReferrals).
 * A sign-up that can already be seen to be abuse is stored as blocked or held,
 * so it shows in the counts.
 */
export async function attributeReferral(input: {
	userId: string;
	email: string;
	code: string;
	ip?: string | null;
	userAgent?: string | null;
	now?: Date;
}): Promise<Attribution> {
	if (!(await referralEnabled())) return "disabled";
	const db = database();
	const now = input.now ?? new Date();
	const owner = await db.query<{ user_id: string; email: string }>(
		`select c.user_id,u.email from referral_code c join auth_user u on u.id=c.user_id where c.code=$1`,
		[input.code],
	);
	const referrer = owner.rows[0];
	if (!referrer) return "unknown_code";
	if (referrer.user_id === input.userId) return "self";
	const referredKey = emailKey(input.email);
	const network = networkKey(input.ip, input.userAgent);
	let status = "attributed";
	let reason: string | null = null;
	if (referredKey === emailKey(referrer.email)) {
		status = "blocked";
		reason = "same_email";
	} else if (network) {
		const recent = await db.query<{ count: string }>(
			"select count(*) from referral where network_key=$1 and attributed_at>$2",
			[network, new Date(now.getTime() - DAY_MS)],
		);
		if (Number(recent.rows[0].count) >= NETWORK_SIGNUPS_PER_DAY) {
			status = "held";
			reason = "network_rate";
		}
	}
	await db.query(
		`insert into referral(referred_user_id,referrer_user_id,code,status,reason,email_key,network_key,attributed_at,decided_at)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(referred_user_id) do nothing`,
		[
			input.userId,
			referrer.user_id,
			input.code,
			status,
			reason,
			referredKey,
			network,
			now,
			status === "attributed" ? null : now,
		],
	);
	return "attributed";
}

type Queryable = Pick<ReturnType<typeof database>, "query">;

async function referrerCaps(db: Queryable, referrerId: string, now: Date) {
	const result = await db.query<{
		in_period: string;
		lifetime: string;
		today: string;
	}>(
		`select
		  (select count(*) from referral_reward where user_id=$1 and role='referrer' and granted_at>$2) as in_period,
		  (select count(*) from referral_reward where user_id=$1 and role='referrer') as lifetime,
		  (select count(*) from referral where referrer_user_id=$1 and status='granted' and decided_at>$3) as today`,
		[
			referrerId,
			new Date(now.getTime() - REFERRER_PERIOD_DAYS * DAY_MS),
			new Date(now.getTime() - DAY_MS),
		],
	);
	const row = result.rows[0];
	return {
		inPeriod: Number(row.in_period),
		lifetime: Number(row.lifetime),
		today: Number(row.today),
	};
}

type DueReferral = {
	referred_user_id: string;
	referrer_user_id: string;
	email_key: string | null;
	network_key: string | null;
	attributed_at: Date;
};

async function decide(row: DueReferral, now: Date) {
	const db = database();
	const [
		users,
		others,
		shared,
		referredSessions,
		referrerSessions,
		caps,
		enabled,
	] = await Promise.all([
		db.query<{ id: string; email: string; verified: boolean }>(
			`select id,email,"emailVerified" as verified from auth_user where id in ($1,$2)`,
			[row.referred_user_id, row.referrer_user_id],
		),
		db.query<{ count: string }>(
			"select count(*) from referral where email_key=$1 and referred_user_id<>$2 and attributed_at<$3",
			[row.email_key, row.referred_user_id, row.attributed_at],
		),
		db.query(
			`select 1 from auth_account a join auth_account b on a."providerId"=b."providerId" and a."accountId"=b."accountId"
				 where a."userId"=$1 and b."userId"=$2 and a."providerId"<>'credential' limit 1`,
			[row.referred_user_id, row.referrer_user_id],
		),
		db.query<{ ip: string | null; ua: string | null }>(
			`select "ipAddress" as ip,"userAgent" as ua from auth_session where "userId"=$1 order by "createdAt" limit 50`,
			[row.referred_user_id],
		),
		db.query<{ ip: string | null; ua: string | null }>(
			`select "ipAddress" as ip,"userAgent" as ua from auth_session where "userId"=$1 and "createdAt">$2 limit 200`,
			[
				row.referrer_user_id,
				new Date(now.getTime() - REFERRER_PERIOD_DAYS * DAY_MS),
			],
		),
		referrerCaps(db, row.referrer_user_id, now),
		referralEnabled(),
	]);
	const referred = users.rows.find((user) => user.id === row.referred_user_id);
	const referrer = users.rows.find((user) => user.id === row.referrer_user_id);
	if (!referred || !referrer) return null;
	const referrerKeys = new Set(
		referrerSessions.rows.flatMap((s) => networkKey(s.ip, s.ua) ?? []),
	);
	const referredKeys = [
		...(row.network_key ? [row.network_key] : []),
		...referredSessions.rows.flatMap((s) => networkKey(s.ip, s.ua) ?? []),
	];
	return decideReferral({
		enabled,
		emailVerified: referred.verified,
		referredEmailKey: row.email_key,
		referrerEmailKey: emailKey(referrer.email),
		otherReferralsWithEmailKey: Number(others.rows[0].count),
		sharedLinkedAccount: shared.rows.length > 0,
		networkMatch: referredKeys.some((k) => referrerKeys.has(k)),
		referrerRewardsInPeriod: caps.inPeriod,
		referrerRewardsLifetime: caps.lifetime,
		referrerDecisionsToday: caps.today,
	});
}

/**
 * Writes the rewards and settles the referral in one transaction under the
 * budget lock. The unique constraints on referral_reward are the last word:
 * a referral that is no longer pending (another worker decided it) is left
 * alone. The caps are counted again here, under the lock.
 */
async function grant(row: DueReferral, rewardReferrer: boolean, now: Date) {
	return withUsageLock(async (client) => {
		const locked = await client.query(
			"select 1 from referral where referred_user_id=$1 and status='pending' for update",
			[row.referred_user_id],
		);
		if (!locked.rows.length) return false;
		const caps = await referrerCaps(client, row.referrer_user_id, now);
		const rewardsReferrer =
			rewardReferrer &&
			caps.inPeriod < REFERRER_REWARDS_PER_PERIOD &&
			caps.lifetime < REFERRER_REWARDS_LIFETIME;
		await client.query(
			"insert into referral_reward(referred_user_id,user_id,role,granted_at) values($1,$1,'referred',$2)",
			[row.referred_user_id, now],
		);
		if (rewardsReferrer)
			await client.query(
				"insert into referral_reward(referred_user_id,user_id,role,granted_at) values($1,$2,'referrer',$3)",
				[row.referred_user_id, row.referrer_user_id, now],
			);
		await client.query(
			"update referral set status='granted',reason=$2,decided_at=$3 where referred_user_id=$1",
			[
				row.referred_user_id,
				rewardsReferrer ? "granted" : "referrer_capped",
				now,
			],
		);
		// Already held back? The reward applies now; otherwise it waits for the limit.
		for (const userId of rewardsReferrer
			? [row.referred_user_id, row.referrer_user_id]
			: [row.referred_user_id])
			await redeemReferralResetIfBlocked(client, userId);
		return true;
	});
}

export type SettleResult = {
	qualified: number;
	granted: number;
	held: number;
	blocked: number;
};

/**
 * One pass of the referral job (every few minutes). First: a referral whose
 * referred account has a verified address and a completed turn starts its
 * delay. Then: each referral whose delay has passed is decided again against
 * every rule and rewarded, held or blocked. Does nothing while referral is off.
 */
export async function settleReferrals(now = new Date()): Promise<SettleResult> {
	const result = { qualified: 0, granted: 0, held: 0, blocked: 0 };
	if (!(await referralEnabled())) return result;
	const db = database();
	const qualified = await db.query(
		`update referral r set status='pending',qualified_at=$1,grant_after=$1::timestamptz + make_interval(mins => $2)
		 from auth_user u
		 where u.id=r.referred_user_id and r.status='attributed' and u."emailVerified"
		  and exists (select 1 from usage_turn_counted t where t.user_id=r.referred_user_id)
		 returning r.referred_user_id`,
		[now, GRANT_DELAY_MINUTES],
	);
	result.qualified = qualified.rows.length;
	const due = await db.query<DueReferral>(
		`select referred_user_id,referrer_user_id,email_key,network_key,attributed_at from referral
		 where status='pending' and grant_after<=$1 order by grant_after limit ${SETTLE_BATCH}`,
		[now],
	);
	for (const row of due.rows) {
		try {
			const decision = await decide(row, now);
			if (!decision || decision.outcome === "wait") continue;
			if (decision.outcome === "grant") {
				if (await grant(row, decision.rewardReferrer, now)) result.granted++;
				continue;
			}
			const settled = await db.query(
				"update referral set status=$2,reason=$3,decided_at=$4 where referred_user_id=$1 and status='pending'",
				[
					row.referred_user_id,
					decision.outcome === "hold" ? "held" : "blocked",
					decision.reason,
					now,
				],
			);
			if (settled.rowCount)
				result[decision.outcome === "hold" ? "held" : "blocked"]++;
		} catch (error) {
			console.error("Could not decide a referral.", {
				referredUserId: row.referred_user_id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

export type ReferralSummary = {
	enabled: boolean;
	code: string;
	/** Sign-ups through the account's code that were not refused. */
	joined: number;
	/** Of those, rewarded or waiting out the delay. */
	qualified: number;
	rewardsInPeriod: number;
	rewardsCap: number;
	/** When the oldest reward in the period ages out, once the cap is reached. */
	nextAvailableAt: string | null;
	/** Rewards earned and not yet applied: they apply when a limit is reached. */
	readyResets: number;
	/** This account joined through someone's code. */
	referredByCode: boolean;
	/** This account already received its reset as the invited person. */
	rewardedAsReferred: boolean;
	/** What the invitation timing needs (src/domain/referral-prompt.ts). */
	completedTurns: number;
	warmupShownAt: string | null;
	lastWindowKey: string | null;
	dismissedAt: string | null;
};

export async function referralSummary(
	userId: string,
	now = new Date(),
): Promise<ReferralSummary> {
	const db = database();
	const [enabled, code] = await Promise.all([
		referralEnabled(),
		ensureReferralCode(userId),
	]);
	const since = new Date(now.getTime() - REFERRER_PERIOD_DAYS * DAY_MS);
	const [counts, period, ready, own, prompt, turns, rewarded] =
		await Promise.all([
			db.query<{ joined: string; qualified: string }>(
				`select count(*) filter (where status<>'blocked') as joined,
			 count(*) filter (where status in ('pending','granted')) as qualified
			 from referral where referrer_user_id=$1`,
				[userId],
			),
			db.query<{ granted_at: Date }>(
				"select granted_at from referral_reward where user_id=$1 and role='referrer' and granted_at>$2 order by granted_at",
				[userId, since],
			),
			db.query<{ count: string }>(
				"select count(*) from referral_reward where user_id=$1 and redeemed_at is null",
				[userId],
			),
			db.query("select 1 from referral where referred_user_id=$1 limit 1", [
				userId,
			]),
			db
				.query<{
					warmup_shown_at: Date | null;
					last_window_key: string | null;
					dismissed_at: Date | null;
				}>(
					"select warmup_shown_at,last_window_key,dismissed_at from referral_prompt where user_id=$1",
					[userId],
				)
				// Bookkeeping never blocks: without it the invitation stays away.
				.catch((error) => {
					console.error("Could not read the referral prompt state.", error);
					const now = new Date();
					return {
						rows: [
							{
								warmup_shown_at: now,
								last_window_key: null,
								dismissed_at: now,
							},
						],
					};
				}),
			db.query<{ count: string }>(
				"select count(*) from usage_turn_counted where user_id=$1",
				[userId],
			),
			db.query(
				"select 1 from referral_reward where user_id=$1 and role='referred' limit 1",
				[userId],
			),
		]);
	const shown = prompt.rows[0];
	const used = period.rows.length;
	return {
		enabled,
		code,
		joined: Number(counts.rows[0].joined),
		qualified: Number(counts.rows[0].qualified),
		rewardsInPeriod: used,
		rewardsCap: REFERRER_REWARDS_PER_PERIOD,
		nextAvailableAt:
			used >= REFERRER_REWARDS_PER_PERIOD
				? new Date(
						new Date(period.rows[0].granted_at).getTime() +
							REFERRER_PERIOD_DAYS * DAY_MS,
					).toISOString()
				: null,
		readyResets: Number(ready.rows[0].count),
		referredByCode: own.rows.length > 0,
		rewardedAsReferred: rewarded.rows.length > 0,
		completedTurns: Number(turns.rows[0].count),
		warmupShownAt: shown?.warmup_shown_at?.toISOString() ?? null,
		lastWindowKey: shown?.last_window_key ?? null,
		dismissedAt: shown?.dismissed_at?.toISOString() ?? null,
	};
}

/** Remember that an invitation was shown: the warm-up, or the one for this usage window. */
export async function recordReferralPromptShown(
	userId: string,
	kind: "warmup" | "near_limit",
	windowKey: string | null,
) {
	await database().query(
		`insert into referral_prompt (user_id,warmup_shown_at,last_shown_at,last_window_key)
		 values ($1, case when $2='warmup' then now() end, now(), case when $2='near_limit' then $3 end)
		 on conflict (user_id) do update set last_shown_at=now(),
		  warmup_shown_at=case when $2='warmup' then coalesce(referral_prompt.warmup_shown_at, now()) else referral_prompt.warmup_shown_at end,
		  last_window_key=case when $2='near_limit' then $3 else referral_prompt.last_window_key end`,
		[userId, kind, windowKey],
	);
}

/** A dismissal keeps the invitation quiet for REFERRAL_PROMPT_QUIET_DAYS. */
export async function dismissReferralPrompt(userId: string) {
	await database().query(
		`insert into referral_prompt (user_id,dismissed_at) values ($1, now())
		 on conflict (user_id) do update set dismissed_at=now()`,
		[userId],
	);
}

/** For the operator: referral counts by status and reason, and the last day's rewards. */
export async function referralCounts() {
	const db = database();
	const [byStatus, rewards] = await Promise.all([
		db.query<{ status: string; reason: string | null; count: string }>(
			"select status,reason,count(*) from referral group by 1,2 order by 1,2",
		),
		db.query<{ count: string }>(
			"select count(*) from referral_reward where granted_at>now()-interval '1 day'",
		),
	]);
	return {
		enabled: await referralEnabled(),
		byStatus: byStatus.rows.map((row) => ({
			...row,
			count: Number(row.count),
		})),
		rewardsLastDay: Number(rewards.rows[0].count),
	};
}
