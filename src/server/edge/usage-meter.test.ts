import { afterEach, expect, it, vi } from "vitest";
import { budgetAdmission } from "./budget-admission";
import { meteredUserId, UsageMeter } from "./usage-meter";

/** A fake SQLite that records every statement. */
function fakeSql() {
	const statements: string[] = [];
	const sql = {
		exec: (query: string) => {
			statements.push(query);
			return { toArray: () => [] };
		},
	};
	return { sql: sql as never, statements };
}

/** What the chat object does for a step: meter, then roll up to the hub. */
async function runStep(users: string | undefined, userId: string) {
	const { sql, statements } = fakeSql();
	const meter = new UsageMeter(sql, () => meteredUserId(users, () => userId));
	const addUsage = vi.fn(async () => undefined);
	meter.record({ requests: 1 });
	meter.record({ wsMsgs: 60 });
	await meter.timeStep(async () => undefined);
	await meter.rollup(addUsage, true);
	return { statements, addUsage, today: meter.today() };
}

const hub = (usage: () => Promise<{ state: string }>) =>
	({ USER_HUBS: { getByName: () => ({ usage }) } }) as never;

afterEach(() => vi.unstubAllEnvs());

it("is off by default: an unlisted user writes no usage and calls no hub", async () => {
	for (const users of [undefined, "", " , ", "someone-else"]) {
		const run = await runStep(users, "u1");
		expect(run.statements).toEqual([]);
		expect(run.addUsage).not.toHaveBeenCalled();
	}
});

it("does not even read the chat identity when nobody is listed", () => {
	const identity = vi.fn(() => "u1");
	expect(meteredUserId(undefined, identity)).toBeNull();
	expect(meteredUserId("", identity)).toBeNull();
	expect(identity).not.toHaveBeenCalled();
});

it("meters a listed user as before", async () => {
	const run = await runStep("u0, u1", "u1");
	expect(run.statements.some((s) => s.includes("usage_day"))).toBe(true);
	expect(run.statements.some((s) => s.includes("insert into usage_day"))).toBe(
		true,
	);
});

it("meters everyone with *", async () => {
	const run = await runStep("*", "anyone");
	expect(run.statements.some((s) => s.includes("insert into usage_day"))).toBe(
		true,
	);
	expect(meteredUserId("*", () => null)).toBeNull();
});

it("never reads the hub for an unlisted user at admission", async () => {
	const usage = vi.fn(async () => ({ state: "blocked" }));
	for (const users of [undefined, "other"]) {
		vi.stubEnv("YTIMESY_CF_BUDGET_USERS", users ?? "");
		expect(await budgetAdmission(hub(usage), "u1")).toMatchObject({
			action: "start",
			degraded: false,
		});
	}
	expect(usage).not.toHaveBeenCalled();
});

it("reads the hub for a listed user and for *, and holds a blocked one", async () => {
	const usage = vi.fn(async () => ({ state: "blocked" }));
	vi.stubEnv("YTIMESY_CF_BUDGET_USERS", "u1");
	expect((await budgetAdmission(hub(usage), "u1")).action).toBe("hold");
	vi.stubEnv("YTIMESY_CF_BUDGET_USERS", "*");
	expect((await budgetAdmission(hub(usage), "u2")).action).toBe("hold");
	expect(usage).toHaveBeenCalledTimes(2);
});

it("keeps the global switch for everyone, listed or not", async () => {
	const usage = vi.fn(async () => ({ state: "ok" }));
	vi.stubEnv("YTIMESY_CF_BUDGET_USERS", "");
	vi.stubEnv("YTIMESY_CF_BUDGET_GLOBAL", "pause");
	expect((await budgetAdmission(hub(usage), "u1")).action).toBe("hold");
	vi.stubEnv("YTIMESY_CF_BUDGET_GLOBAL", "degrade");
	expect(await budgetAdmission(hub(usage), "u1")).toMatchObject({
		action: "start",
		degraded: true,
	});
	expect(usage).not.toHaveBeenCalled();
});
