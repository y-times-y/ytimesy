import { afterEach, expect, it, vi } from "vitest";
import type { OwnerAlert } from "#/domain/owner-alerts";
import { redactErrorText } from "./analytics";
import { alertOwner, ownerAlertsEnabled } from "./owner-alerts";

vi.mock("./database", () => ({
	database: () => {
		throw new Error("no database in this test");
	},
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

it("falls back to once per isolate when the database is unreachable, and never throws", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	const send = vi.fn(async () => true);
	const isolated = { ...alert, key: "isolate-only" };
	expect(await alertOwner(isolated, { send })).toBe("sent");
	expect(await alertOwner(isolated, { send })).toBe("duplicate");
	expect(
		await alertOwner(
			{ ...alert, key: "broken-sender" },
			{
				send: async () => {
					throw new Error("binding down");
				},
			},
		),
	).toBe("failed");
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
