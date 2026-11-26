import { createHash } from "node:crypto";
import {
	type ClaudePlanWindow,
	claudePlanUsageFromJson,
} from "#/domain/claude-plan-usage";
import {
	accountAfterLimit,
	chooseAccount,
	effectiveAccountState,
	limitedUntilFor,
	maskAccountEmail,
	PRIMARY_ACCOUNT_ID,
	type SubscriptionAccount,
	type SubscriptionAccountState,
	type SubscriptionProvider,
} from "#/domain/subscription-accounts";
import { seal, unseal } from "../auth/token-vault";
import {
	checkClaudeSetupToken,
	normalizedSetupToken,
} from "./claude-subscription";
import { database } from "./database";

/**
 * Several accounts of one provider. A provider's existing main connection row
 * (agent_account for Codex, claude_subscription for Claude) is "the slot": it
 * holds the account in use, so the relay, the Claude proxy and the runner
 * boxes keep reading one place. The other accounts wait in
 * subscription_account; switching moves an account's whole state (sealed
 * login, name, limits, order) into the slot and the old one out, under the
 * same row lock token refresh uses. A user with one account never has an
 * extra row and nothing here runs for them.
 */

/** More than this is a sign of pooling; a person owns a handful of plans. */
export const MAX_ACCOUNTS_PER_PROVIDER = 5;
/** A limit seen this soon after a switch may come from the previous account's cached login. */
export const SWITCH_SETTLE_MS = 30_000;

/** The vault binding of a waiting account's token: its user and its own id. */
const binding = (userId: string, accountId: string) => ({
	purpose: `subscription-account:${accountId}`,
	userId,
});
/** The bindings the main connections already use. */
const slotBinding = (provider: SubscriptionProvider, userId: string) => ({
	purpose: provider === "codex" ? "codex-auth" : "claude-subscription",
	userId,
});

/** What the browser may see of an account: never a token, email masked. */
export type PublicSubscriptionAccount = {
	readonly id: string;
	readonly provider: SubscriptionProvider;
	readonly label: string;
	readonly email: string | null;
	readonly planType: string | null;
	readonly state: SubscriptionAccountState;
	readonly message: string | null;
	readonly limitedUntil: number | null;
	readonly priority: number;
	readonly lastUsedAt: number | null;
	readonly connectedAt: number | null;
	/**
	 * The provider's own usage windows for this account (Claude: 5 h and 7 d),
	 * as last read, with those already reset dropped. Empty when unknown.
	 */
	readonly windows: readonly ClaudePlanWindow[];
	/** The account serving turns now (the slot). */
	readonly active: boolean;
};

type Row = {
	id: string;
	label: string | null;
	email: string | null;
	plan_type: string | null;
	status: string;
	message: string | null;
	limited_until: number | null;
	priority: number;
	last_used_at: number | null;
	connected_at: number | null;
	plan_usage?: unknown;
};

const ms = (column: string) => `(extract(epoch from ${column})*1000)::float8`;

const DEFAULT_LABEL: Record<SubscriptionProvider, string> = {
	codex: "ChatGPT account",
	claude: "Claude account",
	grok: "Grok account",
};

function toPublic(
	provider: SubscriptionProvider,
	row: Row,
	active: boolean,
	now: number,
): PublicSubscriptionAccount {
	const stored: SubscriptionAccountState =
		row.status === "limited"
			? "limited"
			: row.status === "expired" || row.status === "refused"
				? "expired"
				: // The Codex slot has no limited status: a future limited_until is it.
					row.limited_until !== null && row.limited_until > now
					? "limited"
					: "valid";
	const state = effectiveAccountState(
		{ state: stored, limitedUntil: row.limited_until },
		now,
	);
	return {
		id: row.id,
		provider,
		label: row.label ?? (active ? "Main account" : DEFAULT_LABEL[provider]),
		email: maskAccountEmail(row.email),
		planType: row.plan_type,
		state,
		message: state === "expired" ? row.message : null,
		limitedUntil: state === "limited" ? row.limited_until : null,
		priority: row.priority,
		lastUsedAt: row.last_used_at,
		connectedAt: row.connected_at,
		windows: currentWindows(row.plan_usage, now),
		active,
	};
}

/** The readings whose window has not reset yet: a spent window's old number says nothing now. */
function currentWindows(usage: unknown, now: number): ClaudePlanWindow[] {
	return (claudePlanUsageFromJson(usage)?.windows ?? []).filter(
		(window) => window.resetsAt === null || window.resetsAt > now,
	);
}

/** Every account of the user: the ones in use first within each provider. */
export async function listSubscriptionAccounts(
	userId: string,
	now = Date.now(),
): Promise<PublicSubscriptionAccount[]> {
	const db = database();
	const [codex, claude, extras] = await Promise.all([
		db.query<Row>(
			`select account_id::text as id,label,email,plan_type,status,message,
			 ${ms("limited_until")} as limited_until,priority,${ms("last_used_at")} as last_used_at,
			 ${ms("updated_at")} as connected_at
			 from agent_account where user_id=$1 and provider='codex'
			 and status in ('connected','expired') and encrypted_codex_auth is not null`,
			[userId],
		),
		db.query<Row>(
			`select account_id::text as id,label,null as email,null as plan_type,
			 status,message,${ms("limited_until")} as limited_until,priority,
			 ${ms("last_used_at")} as last_used_at,${ms("connected_at")} as connected_at,plan_usage
			 from claude_subscription where user_id=$1`,
			[userId],
		),
		db.query<Row & { provider: SubscriptionProvider }>(
			`select id::text,provider,label,email,plan_type,status,message,
			 ${ms("limited_until")} as limited_until,priority,${ms("last_used_at")} as last_used_at,
			 ${ms("connected_at")} as connected_at,plan_usage
			 from subscription_account where user_id=$1`,
			[userId],
		),
	]);
	const all = [
		...codex.rows.map((row) => toPublic("codex", row, true, now)),
		...claude.rows.map((row) => toPublic("claude", row, true, now)),
		...extras.rows.map((row) => toPublic(row.provider, row, false, now)),
	];
	return all.sort(
		(a, b) =>
			a.provider.localeCompare(b.provider) ||
			a.priority - b.priority ||
			(a.connectedAt ?? 0) - (b.connectedAt ?? 0),
	);
}

/** The domain's view, for choosing an account (no display fields). */
export function selectionAccounts(
	accounts: readonly PublicSubscriptionAccount[],
): SubscriptionAccount[] {
	return accounts.map((a) => ({
		id: a.id,
		provider: a.provider,
		label: a.label,
		priority: a.priority,
		state: a.state,
		limitedUntil: a.limitedUntil,
		lastUsedAt: a.lastUsedAt,
	}));
}

function cleanLabel(label: string) {
	const value = label.replace(/\s+/g, " ").trim();
	if (!value || value.length > 60)
		throw new Error("Give the account a name of 1 to 60 characters.");
	return value;
}

async function assertRoom(userId: string, provider: SubscriptionProvider) {
	const accounts = await listSubscriptionAccounts(userId);
	if (
		accounts.filter((a) => a.provider === provider).length >=
		MAX_ACCOUNTS_PER_PROVIDER
	)
		throw new Error(
			`You can connect up to ${MAX_ACCOUNTS_PER_PROVIDER} accounts per provider.`,
		);
}

/** The slot table's statement for one provider; `$1` is the user, `$2` the account id. */
const SLOT = {
	codex: {
		table: "agent_account",
		where: "user_id=$1 and provider='codex' and account_id=$2::uuid",
	},
	claude: {
		table: "claude_subscription",
		where: "user_id=$1 and account_id=$2::uuid",
	},
} as const;

async function slotAccountId(userId: string, provider: SubscriptionProvider) {
	if (provider === "grok") return null;
	const row = (
		await database().query<{ id: string }>(
			provider === "codex"
				? "select account_id::text as id from agent_account where user_id=$1 and provider='codex' and encrypted_codex_auth is not null"
				: "select account_id::text as id from claude_subscription where user_id=$1",
			[userId],
		)
	).rows[0];
	return row?.id ?? null;
}

/** "primary" (the old name for the main connection) means the account in the slot. */
async function resolveAccountId(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
) {
	return accountId === PRIMARY_ACCOUNT_ID
		? ((await slotAccountId(userId, provider)) ?? accountId)
		: accountId;
}

/** Runs the slot's statement for the account, else the waiting account's. */
async function updateAccount(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
	slotSql: string,
	extraSql: string,
	values: readonly unknown[],
) {
	if (provider === "grok") return 0;
	const id = await resolveAccountId(userId, provider, accountId);
	if (!/^[0-9a-f-]{36}$/i.test(id)) return 0;
	const slot = SLOT[provider];
	const inSlot = await database().query(
		`update ${slot.table} set ${slotSql} where ${slot.where}`,
		[userId, id, ...values],
	);
	if (inSlot.rowCount) return inSlot.rowCount;
	const waiting = await database().query(
		`update subscription_account set ${extraSql} where user_id=$1 and id=$2::uuid and provider='${provider}'`,
		[userId, id, ...values],
	);
	return waiting.rowCount ?? 0;
}

/** An extra Claude account, from a `claude setup-token` token (the existing add flow). */
export async function addClaudeAccount(
	userId: string,
	input: { token: string; label: string },
	check: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
	const token = normalizedSetupToken(input.token);
	if (!token)
		throw new Error(
			"That is not a Claude Code token. Run `claude setup-token` and paste the token it prints.",
		);
	const label = cleanLabel(input.label);
	await assertRoom(userId, "claude");
	if ((await checkClaudeSetupToken(token, check)) === "refused")
		throw new Error(
			"Anthropic refused this token. Run claude setup-token again.",
		);
	const externalId = createHash("sha256").update(token).digest("hex");
	// The main Claude connection may already hold this very token.
	const held = await database().query<{ sealed_token: string }>(
		"select sealed_token from claude_subscription where user_id=$1",
		[userId],
	);
	if (
		held.rows[0] &&
		(await unseal(
			held.rows[0].sealed_token,
			slotBinding("claude", userId),
		).catch(() => null)) === token
	)
		throw new Error("This Claude account is already connected.");
	const id = crypto.randomUUID();
	const inserted = await database().query(
		`insert into subscription_account(id,user_id,provider,label,external_id,sealed_auth,priority)
		 values($1,$2,'claude',$3,$4,$5,
		 (select coalesce(max(priority),0)+1 from subscription_account where user_id=$2 and provider='claude'))
		 on conflict(user_id,provider,external_id) do nothing returning id`,
		[id, userId, label, externalId, await seal(token, binding(userId, id))],
	);
	if (!inserted.rows.length)
		throw new Error("This Claude account is already connected.");
	return id;
}

/**
 * An extra Codex account from a finished device sign-in. The caller holds the
 * row lock that serialised the login.
 */
export async function addCodexAccount(
	client: {
		query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
	},
	userId: string,
	input: {
		sealedAuth: (accountId: string) => Promise<string>;
		accountId: string;
		planType: string | null;
		email: string | null;
		label: string;
	},
): Promise<"added" | "duplicate" | "full"> {
	const count = await client.query(
		"select count(*)::int as n from subscription_account where user_id=$1 and provider='codex'",
		[userId],
	);
	if (
		((count.rows[0] as { n: number }).n ?? 0) + 1 >=
		MAX_ACCOUNTS_PER_PROVIDER
	)
		return "full";
	const id = crypto.randomUUID();
	const inserted = await client.query(
		`insert into subscription_account(id,user_id,provider,label,external_id,email,plan_type,sealed_auth,priority)
		 values($1,$2,'codex',$3,$4,$5,$6,$7,
		 (select coalesce(max(priority),0)+1 from subscription_account where user_id=$2 and provider='codex'))
		 on conflict(user_id,provider,external_id) do nothing returning id`,
		[
			id,
			userId,
			cleanLabel(input.label),
			input.accountId,
			input.email,
			input.planType,
			await input.sealedAuth(id),
		],
	);
	return inserted.rows.length ? "added" : "duplicate";
}

/** The seal a waiting account's login uses, so the device flow can store it. */
export const extraAccountSeal = (
	userId: string,
	accountId: string,
	data: string,
) => seal(data, binding(userId, accountId));
export const openExtraAccount = (
	userId: string,
	accountId: string,
	sealed: string,
) => unseal(sealed, binding(userId, accountId));

export async function renameSubscriptionAccount(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
	label: string,
) {
	const name = cleanLabel(label);
	const changed = await updateAccount(
		userId,
		provider,
		accountId,
		"label=$3,updated_at=now()",
		"label=$3,updated_at=now()",
		[name],
	);
	if (!changed) throw new Error("That account no longer exists.");
}

/** The whole state of one account, opened, so it can move between the slot and the waiting rows. */
type Held = {
	accountId: string;
	externalId: string;
	secret: string;
	label: string | null;
	email: string | null;
	planType: string | null;
	state: SubscriptionAccountState;
	message: string | null;
	limitedUntil: Date | null;
	priority: number;
	lastUsedAt: Date | null;
	planUsage: unknown;
	planUsageAt: Date | null;
};

type Client = {
	query: <R = Record<string, unknown>>(
		sql: string,
		values?: unknown[],
	) => Promise<{ rows: R[]; rowCount?: number | null }>;
};

function codexExternalId(secret: string) {
	return (JSON.parse(secret) as { tokens: { account_id: string } }).tokens
		.account_id;
}

async function readSlot(
	client: Client,
	provider: "codex" | "claude",
	userId: string,
): Promise<Held | null> {
	const row = (
		await client.query<{
			account_id: string;
			secret: string;
			label: string | null;
			email: string | null;
			plan_type: string | null;
			status: string;
			message: string | null;
			limited_until: Date | null;
			priority: number;
			last_used_at: Date | null;
			plan_usage: unknown;
			plan_usage_at: Date | null;
		}>(
			provider === "codex"
				? `select account_id::text,encrypted_codex_auth as secret,label,email,plan_type,status,message,
				   limited_until,priority,last_used_at,null as plan_usage,null as plan_usage_at
				   from agent_account where user_id=$1 and provider='codex' and encrypted_codex_auth is not null for update`
				: `select account_id::text,sealed_token as secret,label,null as email,null as plan_type,status,message,
				   limited_until,priority,last_used_at,plan_usage,plan_usage_at
				   from claude_subscription where user_id=$1 for update`,
			[userId],
		)
	).rows[0];
	if (!row) return null;
	const secret = await unseal(row.secret, slotBinding(provider, userId));
	const limited =
		row.status === "limited" ||
		(provider === "codex" &&
			row.limited_until !== null &&
			new Date(row.limited_until).getTime() > Date.now());
	return {
		accountId: row.account_id,
		externalId:
			provider === "codex"
				? codexExternalId(secret)
				: createHash("sha256").update(secret).digest("hex"),
		secret,
		label: row.label,
		email: row.email,
		planType: row.plan_type,
		state:
			row.status === "expired" || row.status === "refused"
				? "expired"
				: limited
					? "limited"
					: "valid",
		message: row.message,
		limitedUntil: row.limited_until,
		priority: row.priority,
		lastUsedAt: row.last_used_at,
		planUsage: row.plan_usage,
		planUsageAt: row.plan_usage_at,
	};
}

async function readWaiting(
	client: Client,
	userId: string,
	accountId: string,
): Promise<Held | null> {
	const row = (
		await client.query<{
			id: string;
			external_id: string;
			sealed_auth: string;
			label: string;
			email: string | null;
			plan_type: string | null;
			status: string;
			message: string | null;
			limited_until: Date | null;
			priority: number;
			last_used_at: Date | null;
			plan_usage: unknown;
			plan_usage_at: Date | null;
		}>(
			`select id::text,external_id,sealed_auth,label,email,plan_type,status,message,limited_until,
			 priority,last_used_at,plan_usage,plan_usage_at
			 from subscription_account where user_id=$1 and id=$2::uuid for update`,
			[userId, accountId],
		)
	).rows[0];
	if (!row) return null;
	return {
		accountId: row.id,
		externalId: row.external_id,
		secret: await unseal(row.sealed_auth, binding(userId, row.id)),
		label: row.label,
		email: row.email,
		planType: row.plan_type,
		state:
			row.status === "limited"
				? "limited"
				: row.status === "expired" || row.status === "refused"
					? "expired"
					: "valid",
		message: row.message,
		limitedUntil: row.limited_until,
		priority: row.priority,
		lastUsedAt: row.last_used_at,
		planUsage: row.plan_usage,
		planUsageAt: row.plan_usage_at,
	};
}

async function writeSlot(
	client: Client,
	provider: "codex" | "claude",
	userId: string,
	held: Held,
) {
	const sealed = await seal(held.secret, slotBinding(provider, userId));
	if (provider === "codex")
		await client.query(
			`update agent_account set account_id=$2::uuid,encrypted_codex_auth=$3,label=$4,email=$5,plan_type=$6,
			 status=$7,message=$8,limited_until=$9,priority=$10,last_used_at=$11,
			 activated_at=now(),updated_at=now() where user_id=$1 and provider='codex'`,
			[
				userId,
				held.accountId,
				sealed,
				held.label,
				held.email,
				held.planType,
				held.state === "expired" ? "expired" : "connected",
				held.message,
				held.limitedUntil,
				held.priority,
				held.lastUsedAt,
			],
		);
	else
		await client.query(
			`update claude_subscription set account_id=$2::uuid,sealed_token=$3,label=$4,
			 status=$5,message=$6,limited_until=$7,priority=$8,last_used_at=$9,
			 plan_usage=$10::jsonb,plan_usage_at=$11,activated_at=now(),updated_at=now() where user_id=$1`,
			[
				userId,
				held.accountId,
				sealed,
				held.label,
				held.state === "expired"
					? "refused"
					: held.state === "limited"
						? "limited"
						: "connected",
				held.message,
				held.limitedUntil,
				held.priority,
				held.lastUsedAt,
				held.planUsage === null ? null : JSON.stringify(held.planUsage),
				held.planUsageAt,
			],
		);
}

async function writeWaiting(
	client: Client,
	provider: "codex" | "claude",
	userId: string,
	replacedId: string,
	held: Held,
) {
	await client.query(
		`update subscription_account set id=$3::uuid,external_id=$4,sealed_auth=$5,label=$6,email=$7,plan_type=$8,
		 status=$9,message=$10,limited_until=$11,priority=$12,last_used_at=$13,
		 plan_usage=$14::jsonb,plan_usage_at=$15,updated_at=now()
		 where user_id=$1 and id=$2::uuid and provider='${provider}'`,
		[
			userId,
			replacedId,
			held.accountId,
			held.externalId,
			await seal(held.secret, binding(userId, held.accountId)),
			held.label ?? "Main account",
			held.email,
			held.planType,
			held.state === "expired"
				? "expired"
				: held.state === "limited"
					? "limited"
					: "connected",
			held.message,
			held.limitedUntil,
			held.priority,
			held.lastUsedAt,
			held.planUsage === null ? null : JSON.stringify(held.planUsage),
			held.planUsageAt,
		],
	);
}

/**
 * Puts the account in the slot (and the slot's account in its place), under
 * the row locks token refresh takes. "already" when it is there.
 */
export async function activateSubscriptionAccount(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
): Promise<"switched" | "already" | "missing"> {
	if (provider === "grok") return "missing";
	const client = await database().connect();
	try {
		await client.query("begin");
		const slot = await readSlot(client, provider, userId);
		if (!slot) {
			await client.query("rollback");
			return "missing";
		}
		if (slot.accountId === accountId) {
			await client.query("rollback");
			return "already";
		}
		const waiting = await readWaiting(client, userId, accountId);
		if (!waiting) {
			await client.query("rollback");
			return "missing";
		}
		await writeWaiting(client, provider, userId, waiting.accountId, slot);
		await writeSlot(client, provider, userId, waiting);
		await client.query("commit");
		return "switched";
	} catch (cause) {
		await client.query("rollback").catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

/** Disconnects one account; the slot's goes first-in-line account into its place. */
export async function removeSubscriptionAccount(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
) {
	if (provider === "grok") return;
	const id = await resolveAccountId(userId, provider, accountId);
	const slotId = await slotAccountId(userId, provider);
	if (id !== slotId) {
		await database().query(
			"delete from subscription_account where user_id=$1 and id=$2::uuid and provider=$3",
			[userId, id, provider],
		);
		return;
	}
	const next = (
		await database().query<{ id: string }>(
			`select id::text from subscription_account where user_id=$1 and provider=$2
			 order by priority,connected_at limit 1`,
			[userId, provider],
		)
	).rows[0];
	if (!next) {
		await database().query(
			provider === "codex"
				? "delete from agent_account where user_id=$1 and provider='codex'"
				: "delete from claude_subscription where user_id=$1",
			[userId],
		);
		return;
	}
	// Swap the next account in, then drop the one that was disconnected.
	await activateSubscriptionAccount(userId, provider, next.id);
	await database().query(
		"delete from subscription_account where user_id=$1 and id=$2::uuid",
		[userId, id],
	);
}

/** Sets the order tried first to last (priority 0, 1, 2 ...). Unknown ids are ignored. */
export async function reorderSubscriptionAccounts(
	userId: string,
	provider: SubscriptionProvider,
	orderedIds: readonly string[],
) {
	let priority = 0;
	for (const id of orderedIds) {
		await updateAccount(userId, provider, id, "priority=$3", "priority=$3", [
			priority,
		]);
		priority += 1;
	}
}

/** Pins a chat to one account, or back to Auto (null). */
export async function pinSessionAccount(
	userId: string,
	sessionId: string,
	accountId: string | null,
) {
	if (accountId !== null && accountId !== PRIMARY_ACCOUNT_ID) {
		const accounts = await listSubscriptionAccounts(userId);
		if (!accounts.some((a) => a.id === accountId))
			throw new Error("That account no longer exists.");
	}
	const result = await database().query(
		"update agent_session set subscription_pin=$3 where id=$1 and user_id=$2",
		[sessionId, userId, accountId],
	);
	if (!result.rowCount) throw new Error("Chat not found.");
}

/** The chat's pin, or null for Auto. */
export async function sessionAccountPin(userId: string, sessionId: string) {
	const row = (
		await database().query<{ subscription_pin: string | null }>(
			"select subscription_pin from agent_session where id=$1 and user_id=$2",
			[sessionId, userId],
		)
	).rows[0];
	return row?.subscription_pin ?? null;
}

/**
 * A plan limit or 429 usage-limit: the account rests until the reset the
 * provider reported (or a short cooldown). Bookkeeping: never throws.
 */
export async function markAccountLimited(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
	input: { reportedResetAt: number | null; now?: number; message?: string },
) {
	const until = limitedUntilFor({
		reportedResetAt: input.reportedResetAt,
		now: input.now ?? Date.now(),
	});
	const message = input.message ?? "This plan's usage is used up for now.";
	try {
		await updateAccount(
			userId,
			provider,
			accountId,
			provider === "codex"
				? "limited_until=to_timestamp($3::float8/1000),message=$4"
				: "status='limited',limited_until=to_timestamp($3::float8/1000),message=$4,updated_at=now()",
			"status='limited',limited_until=to_timestamp($3::float8/1000),message=$4,updated_at=now()",
			[until, message],
		);
	} catch (error) {
		console.warn("Could not record an account limit.", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
	return until;
}

/** Notes that an account served a turn. Never throws. */
export async function recordAccountUsed(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
) {
	try {
		await updateAccount(
			userId,
			provider,
			accountId,
			"last_used_at=now()",
			"last_used_at=now()",
			[],
		);
	} catch (error) {
		console.warn("Could not record which account served a turn.", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
}

async function otherTurnRunning(userId: string, turnId: string | null) {
	const result = await database().query(
		`select 1 from api_turn where user_id=$1 and state='running'
		 and ($2::uuid is null or id <> $2::uuid) limit 1`,
		[userId, turnId],
	);
	return (result.rowCount ?? 0) > 0;
}

export type TurnAccount = {
	readonly accountId: string;
	readonly label: string;
	readonly switched: boolean;
};

/**
 * Before a turn on a Codex or Claude subscription: the chat's pinned account,
 * or Auto's pick, goes into the slot. A user with one account is untouched.
 * Auto stays on the account in use while it is as good as any (no churn); a
 * switch is skipped while another of the user's turns runs, so no running
 * turn changes account under itself. Never throws: on any doubt the turn runs
 * on the account in the slot, as before.
 */
export async function prepareTurnAccount(
	userId: string,
	provider: SubscriptionProvider,
	input: { sessionId: string; turnId: string | null; now?: number },
): Promise<TurnAccount | null> {
	try {
		const now = input.now ?? Date.now();
		const all = (await listSubscriptionAccounts(userId, now)).filter(
			(a) => a.provider === provider,
		);
		if (all.length < 2) return null;
		const active = all.find((a) => a.active);
		if (!active) return null;
		const pinRaw = await sessionAccountPin(userId, input.sessionId);
		const pin = pinRaw
			? await resolveAccountId(userId, provider, pinRaw)
			: null;
		const accounts = selectionAccounts(all);
		let chosen = chooseAccount({ accounts, pinnedId: pin, now, provider });
		const current = accounts.find((a) => a.id === active.id);
		if (
			chosen &&
			current &&
			chosen.id !== current.id &&
			!(pin && chosen.id === pin) &&
			effectiveAccountState(current, now) === "valid" &&
			current.priority === chosen.priority
		)
			chosen = current; // as good as any: stay (no churn)
		if (!chosen) return null;
		let switched = false;
		if (
			chosen.id !== active.id &&
			!(await otherTurnRunning(userId, input.turnId))
		)
			switched =
				(await activateSubscriptionAccount(userId, provider, chosen.id)) ===
				"switched";
		const serving = switched ? chosen : (current ?? chosen);
		await recordAccountUsed(userId, provider, serving.id);
		return { accountId: serving.id, label: serving.label, switched };
	} catch (error) {
		console.warn(
			"Choosing a subscription account failed; using the current one.",
			{
				reason: error instanceof Error ? error.name : "unknown",
			},
		);
		return null;
	}
}

export type LimitRotation =
	| { readonly kind: "rotated"; readonly to: TurnAccount }
	| { readonly kind: "stale" }
	| { readonly kind: "none" };

/**
 * The account in use hit a plan limit: it rests until the reported reset and
 * the next account of the same provider takes over, so the turn goes on
 * without the person seeing an interruption. "none" when no other account can
 * serve (the caller then falls to another provider); "stale" when the limit
 * came right after a switch and may belong to the previous account's cached
 * login (nothing is recorded). Never throws.
 */
export async function rotateAfterLimit(
	userId: string,
	provider: SubscriptionProvider,
	input: { reportedResetAt: number | null; now?: number },
): Promise<LimitRotation> {
	try {
		const now = input.now ?? Date.now();
		const all = (await listSubscriptionAccounts(userId, now)).filter(
			(a) => a.provider === provider,
		);
		const active = all.find((a) => a.active);
		if (!active || all.length < 2) return { kind: "none" };
		const activated = (
			await database().query<{ at: number }>(
				provider === "codex"
					? `select ${ms("activated_at")} as at from agent_account where user_id=$1 and provider='codex'`
					: `select ${ms("activated_at")} as at from claude_subscription where user_id=$1`,
				[userId],
			)
		).rows[0]?.at;
		if (activated !== undefined && now - activated < SWITCH_SETTLE_MS)
			return { kind: "stale" };
		await markAccountLimited(userId, provider, active.id, {
			reportedResetAt: input.reportedResetAt,
			now,
		});
		const rested = (await listSubscriptionAccounts(userId, now)).filter(
			(a) => a.provider === provider,
		);
		const next = accountAfterLimit({
			accounts: selectionAccounts(rested),
			failedId: active.id,
			now,
		});
		if (!next) return { kind: "none" };
		if (
			(await activateSubscriptionAccount(userId, provider, next.id)) !==
			"switched"
		)
			return { kind: "none" };
		await recordAccountUsed(userId, provider, next.id);
		return {
			kind: "rotated",
			to: { accountId: next.id, label: next.label, switched: true },
		};
	} catch (error) {
		console.warn("Switching subscription account after a limit failed.", {
			reason: error instanceof Error ? error.name : "unknown",
		});
		return { kind: "none" };
	}
}
