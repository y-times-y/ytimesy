import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

let db: PGlite;
const alerts: { kind: string; key: string; text: string }[] = [];
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));
vi.mock("../src/server/adapters/owner-alerts", () => ({
	alertOwner: async (alert: { kind: string; key: string; text: string }) => {
		alerts.push(alert);
		return "sent";
	},
}));
const { recordWakeFailure, clearWakeFailures } = await import(
	"../src/server/adapters/machine-wake-failures"
);

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of [
		"20261019130000_owner_alert.sql",
		"20261020140000_owner_alert_codex_egress.sql",
		"20261104190000_chat_wake_failure_alert.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
beforeEach(async () => {
	alerts.length = 0;
	await db.exec("truncate machine_wake_failure");
});
afterAll(() => db.close());

it("emails once, on the third refusal in a row, and a successful wake resets the streak", async () => {
	const cause = new Error("Infrastructure settlement exceeds its reservation.");
	await recordWakeFailure("vm-a", cause);
	await recordWakeFailure("vm-a", cause);
	expect(alerts).toEqual([]);
	await recordWakeFailure("vm-a", cause);
	expect(alerts).toHaveLength(1);
	expect(alerts[0]).toMatchObject({ kind: "chat-wake-failed" });
	expect(alerts[0]?.text).toContain("vm-a");
	expect(alerts[0]?.text).toContain("settlement exceeds its reservation");
	// A fourth refusal does not email again.
	await recordWakeFailure("vm-a", cause);
	expect(alerts).toHaveLength(1);
	// Another VM counts on its own.
	await recordWakeFailure("vm-b", cause);
	expect(alerts).toHaveLength(1);
	await clearWakeFailures("vm-a");
	await recordWakeFailure("vm-a", cause);
	await recordWakeFailure("vm-a", cause);
	expect(alerts).toHaveLength(1);
});

it("never throws, even when its own record cannot be written", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await db.exec(
		"alter table machine_wake_failure rename to machine_wake_failure_gone",
	);
	await expect(
		recordWakeFailure("vm-c", new Error("x")),
	).resolves.toBeUndefined();
	await expect(clearWakeFailures("vm-c")).resolves.toBeUndefined();
	await db.exec(
		"alter table machine_wake_failure_gone rename to machine_wake_failure",
	);
	expect(warn).toHaveBeenCalled();
	warn.mockRestore();
});
