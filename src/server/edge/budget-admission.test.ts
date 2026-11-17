import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { budgetAdmission } from "./budget-admission";

const hub = (usage: () => Promise<{ state: string }>) =>
	({ USER_HUBS: { getByName: () => ({ usage }) } }) as never;

// The budget is opt-in per user (usage-meter.test.ts covers the default-off cases).
beforeEach(() => vi.stubEnv("YTIMESY_CF_BUDGET_USERS", "*"));
afterEach(() => vi.unstubAllEnvs());

it("starts ok, degrades, and holds blocked turns from the hub's state", async () => {
	expect(
		await budgetAdmission(
			hub(async () => ({ state: "ok" })),
			"u",
		),
	).toMatchObject({ action: "start", degraded: false });
	expect(
		await budgetAdmission(
			hub(async () => ({ state: "degrade" })),
			"u",
		),
	).toMatchObject({ action: "start", degraded: true });
	expect(
		await budgetAdmission(
			hub(async () => ({ state: "blocked" })),
			"u",
		),
	).toMatchObject({
		action: "hold",
		message: "Monthly compute budget reached, resets on the 1st",
	});
});

it("fails open when the hub is unreadable, but holds on a spending-cap error", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	expect(
		await budgetAdmission(
			hub(async () => {
				throw new Error("hub down");
			}),
			"u",
		),
	).toMatchObject({ action: "start", degraded: false });
	expect(
		await budgetAdmission(
			hub(async () => {
				throw new Error("Exceeded the account's spending cap");
			}),
			"u",
		),
	).toMatchObject({ action: "hold" });
});

it("honours the global switch before reading the hub", async () => {
	const usage = vi.fn(async () => ({ state: "ok" }));
	vi.stubEnv("YTIMESY_CF_BUDGET_GLOBAL", "pause");
	expect((await budgetAdmission(hub(usage), "u")).action).toBe("hold");
	expect(usage).not.toHaveBeenCalled();
	vi.stubEnv("YTIMESY_CF_BUDGET_GLOBAL", "degrade");
	expect(await budgetAdmission(hub(usage), "u")).toMatchObject({
		action: "start",
		degraded: true,
	});
});
