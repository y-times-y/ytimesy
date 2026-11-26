import { describe, expect, it } from "vitest";
import {
	accountAfterLimit,
	accountChip,
	chooseAccount,
	effectiveAccountState,
	lastUsedLabel,
	limitedUntilFor,
	maskAccountEmail,
	resolveLegacyAccount,
	type SubscriptionAccount,
} from "./subscription-accounts";

const now = 1_800_000_000_000;
const HOUR = 3_600_000;

const account = (
	id: string,
	over: Partial<SubscriptionAccount> = {},
): SubscriptionAccount => ({
	id,
	provider: "codex",
	label: id,
	priority: 0,
	state: "valid",
	limitedUntil: null,
	lastUsedAt: null,
	...over,
});

describe("effective state", () => {
	it("clears a limit once its reset time has passed", () => {
		const a = account("a", { state: "limited", limitedUntil: now - 1 });
		expect(effectiveAccountState(a, now)).toBe("valid");
	});
	it("keeps a limit until the reset time", () => {
		const a = account("a", { state: "limited", limitedUntil: now + HOUR });
		expect(effectiveAccountState(a, now)).toBe("limited");
	});
	it("treats a limit with no known reset as still limited", () => {
		expect(effectiveAccountState(account("a", { state: "limited" }), now)).toBe(
			"limited",
		);
	});
	it("never revives an expired sign-in by time", () => {
		const a = account("a", { state: "expired", limitedUntil: now - HOUR });
		expect(effectiveAccountState(a, now)).toBe("expired");
	});
});

describe("choosing an account", () => {
	it("Auto prefers priority order, then the least recently used", () => {
		const accounts = [
			account("b", { priority: 1, lastUsedAt: now - 5 }),
			account("a", { priority: 0, lastUsedAt: now - 1 }),
			account("c", { priority: 0, lastUsedAt: now - 9 }),
		];
		expect(chooseAccount({ accounts, pinnedId: null, now })?.id).toBe("c");
	});
	it("Auto round-robins: the account just used goes last among equals", () => {
		const accounts = [
			account("a", { lastUsedAt: now - 1 }),
			account("b", { lastUsedAt: now - 2 }),
			account("c", { lastUsedAt: null }),
		];
		expect(chooseAccount({ accounts, pinnedId: null, now })?.id).toBe("c");
	});
	it("skips limited and expired accounts", () => {
		const accounts = [
			account("a", { state: "limited", limitedUntil: now + HOUR }),
			account("b", { state: "expired" }),
			account("c", { priority: 5 }),
		];
		expect(chooseAccount({ accounts, pinnedId: null, now })?.id).toBe("c");
	});
	it("uses an account whose limit has already reset", () => {
		const accounts = [
			account("a", { state: "limited", limitedUntil: now - 1 }),
		];
		expect(chooseAccount({ accounts, pinnedId: null, now })?.id).toBe("a");
	});
	it("returns null when every account is unusable", () => {
		const accounts = [
			account("a", { state: "limited", limitedUntil: now + HOUR }),
		];
		expect(chooseAccount({ accounts, pinnedId: null, now })).toBeNull();
	});
	it("honours a pin while the pinned account works", () => {
		const accounts = [account("a"), account("b", { priority: 9 })];
		expect(chooseAccount({ accounts, pinnedId: "b", now })?.id).toBe("b");
	});
	it("falls back to Auto when the pinned account is limited or gone", () => {
		const accounts = [
			account("a"),
			account("b", { state: "limited", limitedUntil: now + HOUR }),
		];
		expect(chooseAccount({ accounts, pinnedId: "b", now })?.id).toBe("a");
		expect(chooseAccount({ accounts, pinnedId: "zzz", now })?.id).toBe("a");
	});
	it("does not mix providers", () => {
		const accounts = [
			account("claude1", { provider: "claude" }),
			account("codex1"),
		];
		expect(
			chooseAccount({ accounts, pinnedId: null, now, provider: "codex" })?.id,
		).toBe("codex1");
	});
});

describe("failover after a limit", () => {
	it("moves to the next usable account of the same provider", () => {
		const accounts = [
			account("a", { priority: 0 }),
			account("b", { priority: 1 }),
			account("c", { priority: 2 }),
		];
		expect(accountAfterLimit({ accounts, failedId: "a", now })?.id).toBe("b");
	});
	it("never returns the account that just failed, even if its row is stale", () => {
		const accounts = [account("a")];
		expect(accountAfterLimit({ accounts, failedId: "a", now })).toBeNull();
	});
	it("returns null when the provider has no account left, so the caller falls to another provider", () => {
		const accounts = [
			account("a"),
			account("b", { state: "limited", limitedUntil: now + HOUR }),
		];
		expect(accountAfterLimit({ accounts, failedId: "a", now })).toBeNull();
	});
});

describe("reset time", () => {
	it("uses the provider's reported reset", () => {
		expect(limitedUntilFor({ reportedResetAt: now + 2 * HOUR, now })).toBe(
			now + 2 * HOUR,
		);
	});
	it("falls back to a short cooldown when none is reported", () => {
		const until = limitedUntilFor({ reportedResetAt: null, now });
		expect(until).toBeGreaterThan(now);
		expect(until).toBeLessThanOrEqual(now + HOUR);
	});
	it("ignores a reset in the past and a absurdly distant one", () => {
		expect(
			limitedUntilFor({ reportedResetAt: now - 1, now }),
		).toBeLessThanOrEqual(now + HOUR);
		expect(
			limitedUntilFor({ reportedResetAt: now + 400 * 24 * HOUR, now }),
		).toBeLessThanOrEqual(now + 8 * 24 * HOUR);
	});
});

describe("display", () => {
	it("masks an email", () => {
		expect(maskAccountEmail("alice.smith@example.com")).toBe(
			"a•••@example.com",
		);
		expect(maskAccountEmail("a@x.io")).toBe("a•••@x.io");
		expect(maskAccountEmail(null)).toBeNull();
		expect(maskAccountEmail("not-an-email")).toBeNull();
	});
});

describe("back-compat with the single connection", () => {
	it("presents an existing connection as the primary account", () => {
		const legacy = resolveLegacyAccount({
			provider: "claude",
			status: "limited",
			limitedUntil: now + HOUR,
			connectedAt: now - 10,
		});
		expect(legacy).toMatchObject({
			id: "primary",
			provider: "claude",
			state: "limited",
			limitedUntil: now + HOUR,
			priority: 0,
		});
	});
	it("returns null when there is no connection", () => {
		expect(resolveLegacyAccount(null)).toBeNull();
	});
});

describe("status chip", () => {
	const at = (ms: number) => `T${ms - now}`;
	it("shows when a limit clears, and nothing once it has", () => {
		expect(
			accountChip({ state: "limited", limitedUntil: now + HOUR }, now, at),
		).toEqual({ text: `Limited · resets T${HOUR}`, tone: "limited" });
		expect(
			accountChip({ state: "limited", limitedUntil: now - 1 }, now, at),
		).toEqual({ text: "Ready", tone: "ok" });
	});
	it("says so when the provider gave no reset", () => {
		expect(
			accountChip({ state: "limited", limitedUntil: null }, now, at).text,
		).toBe("Limited for now");
	});
	it("asks to sign in again for an expired login", () => {
		expect(
			accountChip({ state: "expired", limitedUntil: null }, now, at),
		).toEqual({ text: "Sign in again", tone: "attention" });
	});
});

describe("last used label", () => {
	it("reads calmly", () => {
		expect(lastUsedLabel(null, now)).toBe("Not used yet");
		expect(lastUsedLabel(now - 10_000, now)).toBe("Used just now");
		expect(lastUsedLabel(now - 5 * 60_000, now)).toBe("Used 5 min ago");
		expect(lastUsedLabel(now - 3 * HOUR, now)).toBe("Used 3 h ago");
		expect(lastUsedLabel(now - 72 * HOUR, now)).toBe("Used 3 d ago");
	});
});
