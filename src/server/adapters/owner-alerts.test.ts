import { afterEach, expect, it, vi } from "vitest";
import type { OwnerAlert } from "#/domain/owner-alerts";
import { redactErrorText } from "./analytics";
import { alertOwner, ownerAlertsEnabled } from "./owner-alerts";

// The owner_alert table, shared by every isolate (module instance) below.
const table = vi.hoisted(() => ({
	rows: new Set<string>(),
	down: true,
}));
vi.mock("./database", () => ({
	database: () => ({
		query: async (_sql: string, [kind, key]: string[]) => {
			if (table.down)
				throw new Error("connect ETIMEDOUT postgres://u:hunter2@db");
			const id = `${kind}:${key}`;
			if (table.rows.has(id)) return { rowCount: 0, rows: [] };
			table.rows.add(id);
			return { rowCount: 1, rows: [{ "?column?": 1 }] };
		},
	}),
}));

const alert = {
	kind: "cron-failure" as const,
	key: "maintenance:reconcile:2026-10-19T09",
	subject: "ytimesy: scheduled job maintenance:reconcile failed",
	text: "The scheduled job failed.",
};

afterEach(() => vi.unstubAllEnvs());

it("alerts the owner only in production unless enabled", async () => {
	expect(ownerAlertsEnabled({})).toBe(false);
	expect(ownerAlertsEnabled({ YTIMESY_ENVIRONMENT: "production" })).toBe(true);
	expect(ownerAlertsEnabled({ YTIMESY_OWNER_ALERTS: "true" })).toBe(true);
	const send = vi.fn(async () => true);
	expect(await alertOwner(alert, { send, claim: async () => true })).toBe(
		"disabled",
	);
	expect(send).not.toHaveBeenCalled();
});

it("emails the owner once per alert key", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	const claimed = new Set<string>();
	const claim = async (next: OwnerAlert) => {
		const id = `${next.kind}:${next.key}`;
		if (claimed.has(id)) return false;
		claimed.add(id);
		return true;
	};
	const send = vi.fn(
		async (_message: { to: string; subject: string; text: string }) => true,
	);
	expect(await alertOwner(alert, { send, claim })).toBe("sent");
	expect(await alertOwner(alert, { send, claim })).toBe("duplicate");
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0][0]).toMatchObject({
		to: "het@ytimesy.com",
		subject: alert.subject,
	});
	expect(send.mock.calls[0][0].text).toContain("Environment: production");
	vi.stubEnv("YTIMESY_ALERT_EMAIL", "ops@example.test");
	await alertOwner({ ...alert, key: "other" }, { send, claim });
	expect(send.mock.calls[1][0].to).toBe("ops@example.test");
});

it("still alerts once when the database claim fails, using the shared cache, and never throws", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	table.down = true;
	// The Workers cache, shared by every isolate in the cron's location.
	const store = new Map<string, Response>();
	vi.stubGlobal("caches", {
		default: {
			match: async (request: Request) => store.get(request.url),
			put: async (request: Request, response: Response) => {
				store.set(request.url, response);
			},
		},
	});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const send = vi.fn(async () => true);
	const unrecorded = { ...alert, key: "database-down" };
	expect(await alertOwner(unrecorded, { send })).toBe("sent");
	expect(await alertOwner(unrecorded, { send })).toBe("duplicate");
	expect(send).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2");
	warn.mockRestore();
	vi.unstubAllGlobals();
	expect(
		await alertOwner(
			{ ...alert, key: "broken-sender" },
			{
				claim: async () => true,
				send: async () => {
					throw new Error("binding down");
				},
			},
		),
	).toBe("failed");
});

it("emails once per key across isolates, as cron ticks land in fresh ones", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	table.down = false;
	const send = vi.fn(async () => true);
	const hourly = { ...alert, key: "maintenance:infrastructure:2026-11-03T00" };
	// Five failures in one hour, each in a newly loaded module (a new isolate).
	const outcomes = [];
	for (let tick = 0; tick < 5; tick++) {
		vi.resetModules();
		const isolate = await import("./owner-alerts");
		outcomes.push(await isolate.alertOwner(hourly, { send }));
	}
	expect(outcomes).toEqual([
		"sent",
		"duplicate",
		"duplicate",
		"duplicate",
		"duplicate",
	]);
	expect(send).toHaveBeenCalledTimes(1);
	// The next hour's key is a new alert.
	const next = await import("./owner-alerts");
	expect(
		await next.alertOwner(
			{ ...hourly, key: "maintenance:infrastructure:2026-11-03T01" },
			{ send },
		),
	).toBe("sent");
});

it("redacts tokens and URL credentials from tracked error text", () => {
	const text = redactErrorText(
		"fetch https://user:hunter2@db.example/x failed: Bearer abcdefghijklmnop sk-proj-ABCDEFGH12345678 at /Users/me/src/server/adapters/github.ts:12",
	);
	expect(text).not.toContain("hunter2");
	expect(text).not.toContain("abcdefghijklmnop");
	expect(text).not.toContain("sk-proj-ABCDEFGH12345678");
	expect(text).toContain("/Users/me/src/server/adapters/github.ts:12");
});
