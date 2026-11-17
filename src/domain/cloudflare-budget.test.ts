import { expect, it } from "vitest";
import {
	BUDGET_BLOCKED_MESSAGE,
	billedDoRequests,
	budgetAppliesTo,
	budgetDayKey,
	budgetMessage,
	budgetPeriodKey,
	budgetState,
	cloudflareBudgetFromEnv,
	cloudflareBudgetUsers,
	DEFAULT_CLOUDFLARE_BUDGET,
	EMPTY_USAGE,
	gbSecondsFromWallMs,
	globalBudgetMode,
	isSpendingCapError,
	turnAdmission,
} from "./cloudflare-budget";

it("bills 128 MB: 22,400 active seconds is 2,800 GB-s", () => {
	expect(gbSecondsFromWallMs(22_400_000)).toBe(2_800);
	expect(gbSecondsFromWallMs(-5)).toBe(0);
	expect(gbSecondsFromWallMs(Number.NaN)).toBe(0);
});

it("counts alarms and a twentieth of WebSocket messages as requests", () => {
	expect(
		billedDoRequests({ ...EMPTY_USAGE, requests: 10, alarms: 5, wsMsgs: 41 }),
	).toBe(18);
});

it("is ok, degrade from 70% and blocked at 100% of any resource", () => {
	const at = (wallS: number) => ({ ...EMPTY_USAGE, wallMs: wallS * 1000 });
	expect(budgetState(EMPTY_USAGE)).toBe("ok");
	expect(budgetState(at(22_399))).toBe("ok");
	expect(budgetState(at(22_400))).toBe("degrade");
	expect(budgetState(at(20_000))).toBe("ok");
	expect(budgetState(at(32_000))).toBe("blocked");
	expect(budgetState({ ...EMPTY_USAGE, requests: 7_000 })).toBe("degrade");
	expect(budgetState({ ...EMPTY_USAGE, requests: 10_000 })).toBe("blocked");
	expect(budgetState({ ...EMPTY_USAGE, workerRequests: 100_000 })).toBe(
		"blocked",
	);
	expect(budgetState({ ...EMPTY_USAGE, workerRequests: 70_000 })).toBe(
		"degrade",
	);
});

it("reads budgets from the environment and ignores bad values", () => {
	expect(cloudflareBudgetFromEnv({})).toEqual(DEFAULT_CLOUDFLARE_BUDGET);
	expect(
		cloudflareBudgetFromEnv({
			YTIMESY_CF_BUDGET_DO_GB_SECONDS: "100",
			YTIMESY_CF_BUDGET_DO_REQUESTS: "abc",
			YTIMESY_CF_BUDGET_DEGRADE_PERCENT: "50",
		}),
	).toEqual({
		...DEFAULT_CLOUDFLARE_BUDGET,
		doGbSeconds: 100,
		degradePercent: 50,
	});
	expect(
		budgetState(
			{ ...EMPTY_USAGE, requests: 70 },
			{ ...DEFAULT_CLOUDFLARE_BUDGET, doRequests: 100 },
		),
	).toBe("degrade");
});

it("keys the period by UTC month and the day by UTC date", () => {
	expect(budgetPeriodKey(Date.UTC(2026, 10, 30, 23, 59))).toBe("2026-11");
	expect(budgetPeriodKey(Date.UTC(2026, 11, 1, 0, 0))).toBe("2026-12");
	expect(budgetDayKey(Date.UTC(2026, 10, 16, 5))).toBe("2026-11-16");
});

it("parses the opt-in user list: empty is nobody, * is everyone", () => {
	const none = cloudflareBudgetUsers(undefined);
	expect(none.size).toBe(0);
	expect(cloudflareBudgetUsers(" , ").size).toBe(0);
	expect(budgetAppliesTo(none, "u1")).toBe(false);
	const some = cloudflareBudgetUsers("u1, u2");
	expect(budgetAppliesTo(some, "u2")).toBe(true);
	expect(budgetAppliesTo(some, "u3")).toBe(false);
	expect(budgetAppliesTo(cloudflareBudgetUsers("*"), "u3")).toBe(true);
	expect(budgetAppliesTo(cloudflareBudgetUsers("*"), null)).toBe(false);
});

it("parses the global switch", () => {
	expect(globalBudgetMode(undefined)).toBe("off");
	expect(globalBudgetMode("PAUSE")).toBe("pause");
	expect(globalBudgetMode("degrade")).toBe("degrade");
	expect(globalBudgetMode("nonsense")).toBe("off");
});

it("decides turn admission from a fake usage state and the global switch", () => {
	expect(turnAdmission("ok")).toMatchObject({
		action: "start",
		degraded: false,
	});
	expect(turnAdmission("degrade")).toMatchObject({
		action: "start",
		degraded: true,
	});
	expect(turnAdmission("blocked")).toEqual({
		action: "hold",
		degraded: true,
		message: BUDGET_BLOCKED_MESSAGE,
	});
	// Unreadable usage fails open.
	expect(turnAdmission(null)).toMatchObject({
		action: "start",
		degraded: false,
	});
	expect(turnAdmission("ok", "degrade")).toMatchObject({
		action: "start",
		degraded: true,
	});
	expect(turnAdmission("ok", "pause").action).toBe("hold");
	expect(budgetMessage("blocked")).toBe(
		"Monthly compute budget reached, resets on the 1st",
	);
	expect(budgetMessage("ok")).toBeNull();
});

it("recognises spending-cap errors", () => {
	expect(
		isSpendingCapError(new Error("Exceeded the account's spending cap")),
	).toBe(true);
	expect(isSpendingCapError("spending limit reached")).toBe(true);
	expect(isSpendingCapError(new Error("network lost"))).toBe(false);
});
