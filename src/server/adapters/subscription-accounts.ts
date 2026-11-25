import { createHash } from "node:crypto";
import {
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

/** More than this is a sign of pooling; a person owns a handful of plans. */
export const MAX_ACCOUNTS_PER_PROVIDER = 5;

/** The vault binding of an extra account's token: its user and its own id. */
const binding = (userId: string, accountId: string) => ({
	purpose: `subscription-account:${accountId}`,
	userId,
});
/** The bindings the single (primary) connections already use. */
const primaryBinding = (provider: SubscriptionProvider, userId: string) => ({
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
	readonly primary: boolean;
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
	primary: boolean,
	now: number,
): PublicSubscriptionAccount {
	const stored: SubscriptionAccountState =
		row.status === "limited"
			? "limited"
			: row.status === "expired" || row.status === "refused"
				? "expired"
				: // The Codex primary has no limited status: a future limited_until is it.
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
		label: row.label ?? (primary ? "Main account" : DEFAULT_LABEL[provider]),
		email: maskAccountEmail(row.email),
		planType: row.plan_type,
		state,
		message: state === "expired" ? row.message : null,
		limitedUntil: state === "limited" ? row.limited_until : null,
		priority: row.priority,
		lastUsedAt: row.last_used_at,
		connectedAt: row.connected_at,
		primary,
	};
}

/** Every account of the user: the primary connections first, then the extras. */
export async function listSubscriptionAccounts(
	userId: string,
	now = Date.now(),
): Promise<PublicSubscriptionAccount[]> {
	const db = database();
	const [codex, claude, extras] = await Promise.all([
		db.query<Row>(
			`select '${PRIMARY_ACCOUNT_ID}' as id,label,email,plan_type,status,message,
			 ${ms("limited_until")} as limited_until,priority,${ms("last_used_at")} as last_used_at,
			 ${ms("updated_at")} as connected_at
			 from agent_account where user_id=$1 and provider='codex'
			 and status in ('connected','expired') and encrypted_codex_auth is not null`,
			[userId],
		),
		db.query<Row>(
			`select '${PRIMARY_ACCOUNT_ID}' as id,label,null as email,null as plan_type,
			 status,message,${ms("limited_until")} as limited_until,priority,
			 ${ms("last_used_at")} as last_used_at,${ms("connected_at")} as connected_at
			 from claude_subscription where user_id=$1`,
			[userId],
		),
		db.query<Row & { provider: SubscriptionProvider }>(
			`select id::text,provider,label,email,plan_type,status,message,
			 ${ms("limited_until")} as limited_until,priority,${ms("last_used_at")} as last_used_at,
			 ${ms("connected_at")} as connected_at
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
	const primary = await database().query<{ sealed_token: string }>(
		"select sealed_token from claude_subscription where user_id=$1",
		[userId],
	);
	if (
		primary.rows[0] &&
		(await unseal(
			primary.rows[0].sealed_token,
			primaryBinding("claude", userId),
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
 * row lock that serialised the login; `auth` is the managed login JSON.
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
): Promise<"added" | "duplicate"> {
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

/** The seal an extra account's login uses, so the device flow can store it. */
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
	const result =
		accountId === PRIMARY_ACCOUNT_ID
			? await database().query(
					provider === "codex"
						? "update agent_account set label=$2,updated_at=now() where user_id=$1 and provider='codex'"
						: "update claude_subscription set label=$2,updated_at=now() where user_id=$1",
					[userId, name],
				)
			: await database().query(
					"update subscription_account set label=$3,updated_at=now() where user_id=$1 and id=$2::uuid and provider=$4",
					[userId, accountId, name, provider],
				);
	if (!result.rowCount) throw new Error("That account no longer exists.");
}

/**
 * Disconnects one account. Disconnecting the main one promotes the next
 * account into its place (re-sealed under the main binding), because every
 * existing code path reads the main connection.
 */
export async function removeSubscriptionAccount(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
) {
	if (accountId !== PRIMARY_ACCOUNT_ID) {
		await database().query(
			"delete from subscription_account where user_id=$1 and id=$2::uuid and provider=$3",
			[userId, accountId, provider],
		);
		return;
	}
	const next = (
		await database().query<{
			id: string;
			sealed_auth: string;
			label: string;
			email: string | null;
			plan_type: string | null;
			status: string;
			message: string | null;
			limited_until: Date | null;
		}>(
			`select id::text,sealed_auth,label,email,plan_type,status,message,limited_until
			 from subscription_account where user_id=$1 and provider=$2
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
	const plain = await unseal(next.sealed_auth, binding(userId, next.id));
	const sealed = await seal(plain, primaryBinding(provider, userId));
	if (provider === "codex")
		await database().query(
			`insert into agent_account(user_id,provider,status,encrypted_codex_auth,plan_type,email,label,priority,limited_until)
			 values($1,'codex','connected',$2,$3,$4,$5,0,$6)
			 on conflict(user_id,provider) do update set status='connected',encrypted_codex_auth=excluded.encrypted_codex_auth,
			 plan_type=excluded.plan_type,email=excluded.email,label=excluded.label,priority=0,
			 limited_until=excluded.limited_until,message=null,updated_at=now()`,
			[
				userId,
				sealed,
				next.plan_type,
				next.email,
				next.label,
				next.limited_until,
			],
		);
	else
		await database().query(
			`insert into claude_subscription(user_id,sealed_token,status,message,limited_until,label,priority)
			 values($1,$2,$3,$4,$5,$6,0)
			 on conflict(user_id) do update set sealed_token=excluded.sealed_token,status=excluded.status,
			 message=excluded.message,limited_until=excluded.limited_until,label=excluded.label,priority=0,updated_at=now()`,
			[
				userId,
				sealed,
				next.status === "expired" ? "refused" : next.status,
				next.message,
				next.limited_until,
				next.label,
			],
		);
	await database().query("delete from subscription_account where id=$1::uuid", [
		next.id,
	]);
}

/** Sets the order tried first to last (priority 0, 1, 2 ...). Unknown ids are ignored. */
export async function reorderSubscriptionAccounts(
	userId: string,
	provider: SubscriptionProvider,
	orderedIds: readonly string[],
) {
	let priority = 0;
	for (const id of orderedIds) {
		if (id === PRIMARY_ACCOUNT_ID)
			await database().query(
				provider === "codex"
					? "update agent_account set priority=$2 where user_id=$1 and provider='codex'"
					: "update claude_subscription set priority=$2 where user_id=$1",
				[userId, priority],
			);
		else
			await database().query(
				"update subscription_account set priority=$3 where user_id=$1 and id=$2::uuid and provider=$4",
				[userId, id, priority, provider],
			);
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
		const exists = await database().query(
			"select 1 from subscription_account where user_id=$1 and id=$2::uuid",
			[userId, accountId],
		);
		if (!exists.rowCount) throw new Error("That account no longer exists.");
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
		if (accountId === PRIMARY_ACCOUNT_ID)
			await database().query(
				provider === "codex"
					? "update agent_account set limited_until=to_timestamp($2::float8/1000),message=$3 where user_id=$1 and provider='codex'"
					: "update claude_subscription set status='limited',limited_until=to_timestamp($2::float8/1000),message=$3,updated_at=now() where user_id=$1",
				[userId, until, message],
			);
		else
			await database().query(
				"update subscription_account set status='limited',limited_until=to_timestamp($3::float8/1000),message=$4,updated_at=now() where user_id=$1 and id=$2::uuid",
				[userId, accountId, until, message],
			);
	} catch (error) {
		console.warn("Could not record an account limit.", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
	return until;
}

/** Notes that an account served a turn (the round robin). Never throws. */
export async function recordAccountUsed(
	userId: string,
	provider: SubscriptionProvider,
	accountId: string,
) {
	try {
		await database().query(
			accountId === PRIMARY_ACCOUNT_ID
				? provider === "codex"
					? "update agent_account set last_used_at=now() where user_id=$1 and provider='codex' and $2::text is not null"
					: "update claude_subscription set last_used_at=now() where user_id=$1 and $2::text is not null"
				: "update subscription_account set last_used_at=now() where user_id=$1 and id=$2::uuid",
			[userId, accountId],
		);
	} catch (error) {
		console.warn("Could not record which account served a turn.", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
}
