/**
 * Several subscription accounts of one provider (two ChatGPT plans, two
 * Claude plans), owned by one person. Pure rules, no I/O: which account a turn
 * uses, what a limit does to an account, and when it clears.
 *
 * An account that is limited stays out of rotation until the time its
 * provider reported; with no reported time it rests for a short cooldown and
 * is then tried again. An expired sign-in only the person can fix.
 */
export type SubscriptionProvider = "codex" | "claude" | "grok";
export type SubscriptionAccountState = "valid" | "expired" | "limited";

/** The id a pre-existing single connection keeps (no row move, no re-seal). */
export const PRIMARY_ACCOUNT_ID = "primary";

export type SubscriptionAccount = {
	readonly id: string;
	readonly provider: SubscriptionProvider;
	readonly label: string;
	/** Lower is tried first. */
	readonly priority: number;
	readonly state: SubscriptionAccountState;
	/** Epoch ms the provider said this account works again. */
	readonly limitedUntil: number | null;
	/** Epoch ms of the last turn this account served. */
	readonly lastUsedAt: number | null;
};

/** Rest after a limit that came with no reset time. */
export const UNREPORTED_LIMIT_COOLDOWN_MS = 15 * 60_000;
/** The longest provider window (weekly) plus a day; anything beyond is noise. */
export const MAX_LIMIT_MS = 8 * 24 * 3_600_000;

/** The state to show and to act on at `now`: a passed reset clears the limit. */
export function effectiveAccountState(
	account: Pick<SubscriptionAccount, "state" | "limitedUntil">,
	now: number,
): SubscriptionAccountState {
	if (account.state !== "limited") return account.state;
	if (account.limitedUntil !== null && account.limitedUntil <= now)
		return "valid";
	return "limited";
}

/** Until when a limit hit at `now` keeps the account out. */
export function limitedUntilFor(input: {
	reportedResetAt: number | null;
	now: number;
}): number {
	const { reportedResetAt, now } = input;
	if (
		reportedResetAt !== null &&
		Number.isFinite(reportedResetAt) &&
		reportedResetAt > now
	)
		return Math.min(reportedResetAt, now + MAX_LIMIT_MS);
	return now + UNREPORTED_LIMIT_COOLDOWN_MS;
}

function rotationOrder(a: SubscriptionAccount, b: SubscriptionAccount) {
	if (a.priority !== b.priority) return a.priority - b.priority;
	// Never used first, then the longest idle: round robin among equals.
	const lastA = a.lastUsedAt ?? Number.NEGATIVE_INFINITY;
	const lastB = b.lastUsedAt ?? Number.NEGATIVE_INFINITY;
	if (lastA !== lastB) return lastA < lastB ? -1 : 1;
	return a.id < b.id ? -1 : 1;
}

function usable(
	accounts: readonly SubscriptionAccount[],
	now: number,
	provider?: SubscriptionProvider,
) {
	return accounts
		.filter(
			(account) =>
				(!provider || account.provider === provider) &&
				effectiveAccountState(account, now) === "valid",
		)
		.sort(rotationOrder);
}

/**
 * The account for a turn: the pinned one while it works, otherwise Auto's
 * pick. A pin on a limited, expired or removed account falls back to Auto
 * rather than interrupting the person.
 */
export function chooseAccount(input: {
	accounts: readonly SubscriptionAccount[];
	pinnedId: string | null;
	now: number;
	provider?: SubscriptionProvider;
}): SubscriptionAccount | null {
	const candidates = usable(input.accounts, input.now, input.provider);
	if (input.pinnedId) {
		const pinned = candidates.find((a) => a.id === input.pinnedId);
		if (pinned) return pinned;
	}
	return candidates[0] ?? null;
}

/**
 * The next account of the same provider after `failedId` hit a limit; null
 * when none is left, and the caller then falls to another provider.
 */
export function accountAfterLimit(input: {
	accounts: readonly SubscriptionAccount[];
	failedId: string;
	now: number;
}): SubscriptionAccount | null {
	const failed = input.accounts.find((a) => a.id === input.failedId);
	return (
		usable(
			input.accounts.filter((a) => a.id !== input.failedId),
			input.now,
			failed?.provider,
		)[0] ?? null
	);
}

/** `alice@example.com` → `a•••@example.com`; null when it is not an address. */
export function maskAccountEmail(email: string | null): string | null {
	if (!email) return null;
	const at = email.lastIndexOf("@");
	if (at < 1 || at === email.length - 1) return null;
	return `${email[0]}•••${email.slice(at)}`;
}

/** An existing single connection, shown as the primary account. */
export function resolveLegacyAccount(
	connection: {
		provider: SubscriptionProvider;
		status: SubscriptionAccountState | "connected" | "refused";
		limitedUntil: number | null;
		connectedAt: number;
		label?: string;
	} | null,
): SubscriptionAccount | null {
	if (!connection) return null;
	const state: SubscriptionAccountState =
		connection.status === "limited"
			? "limited"
			: connection.status === "refused" || connection.status === "expired"
				? "expired"
				: "valid";
	return {
		id: PRIMARY_ACCOUNT_ID,
		provider: connection.provider,
		label: connection.label ?? "Main account",
		priority: 0,
		state,
		limitedUntil: connection.limitedUntil,
		lastUsedAt: null,
	};
}

/** The status chip an account shows: what it is, and when a limit clears. */
export function accountChip(
	account: Pick<SubscriptionAccount, "state" | "limitedUntil">,
	now: number,
	formatTime: (epochMs: number) => string,
): { readonly text: string; readonly tone: "ok" | "limited" | "attention" } {
	const state = effectiveAccountState(account, now);
	if (state === "limited")
		return {
			text:
				account.limitedUntil !== null
					? `Limited · resets ${formatTime(account.limitedUntil)}`
					: "Limited for now",
			tone: "limited",
		};
	if (state === "expired") return { text: "Sign in again", tone: "attention" };
	return { text: "Ready", tone: "ok" };
}

/** "5 min ago", "2 h ago", "3 d ago"; "Not used yet" when never. */
export function lastUsedLabel(lastUsedAt: number | null, now: number): string {
	if (lastUsedAt === null) return "Not used yet";
	const minutes = Math.max(0, Math.round((now - lastUsedAt) / 60_000));
	if (minutes < 1) return "Used just now";
	if (minutes < 60) return `Used ${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `Used ${hours} h ago`;
	return `Used ${Math.round(hours / 24)} d ago`;
}
