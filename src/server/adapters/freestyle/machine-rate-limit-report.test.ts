import { expect, it, vi } from "vitest";
import { reportMachineRateLimit } from "./machine-rate-limit-report";

const hit = { operation: "provisionSession", slug: "ytimesy-ag-x", attempt: 3 };

it("records an interruption_event row for the hit and alerts the owner once per hour key", async () => {
	const record = vi.fn(async () => "recorded" as const);
	const alert = vi.fn(async () => "sent" as const);
	await reportMachineRateLimit(hit, {
		record,
		alert,
		now: new Date("2026-11-25T19:30:00Z"),
	});
	expect(record).toHaveBeenCalledWith({
		kind: "machine.rate_limited",
		sessionId: "ytimesy-ag-x",
		cause: "provisionSession attempt 3",
		recovered: true,
		userVisible: false,
	});
	expect(alert).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: "provider-account-limit",
			key: "2026-11-25T19",
		}),
	);
});

it("never throws when the database or the email fails", async () => {
	await expect(
		reportMachineRateLimit(hit, {
			record: async () => {
				throw new Error("down");
			},
		}),
	).resolves.toBeUndefined();
});

it("reports provider capacity under its own kind and an email that says what the provider said", async () => {
	const record = vi.fn(async () => "recorded" as const);
	const alert = vi.fn(async () => "sent" as const);
	await reportMachineRateLimit(
		{
			...hit,
			operation: "ensureRunning",
			attempt: 1,
			limit: "provider-capacity",
		},
		{ record, alert, now: new Date("2026-11-28T03:30:00Z") },
	);
	expect(record).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "machine.provider_capacity" }),
	);
	const sent = (
		alert.mock.calls[0] as unknown as [{ kind: string; text: string }]
	)[0];
	expect(sent.kind).toBe("provider-capacity");
	expect(sent.text).toContain("server is at capacity");
	expect(sent.text).toContain("not one of our account limits");
	expect(sent.text).not.toContain("account resource limit");
});

it("an unnamed 429 no longer claims to be the account resource limit", async () => {
	const alert = vi.fn(async () => "sent" as const);
	await reportMachineRateLimit(
		{ ...hit, limit: "unspecified" },
		{ record: async () => "recorded" as const, alert },
	);
	const sent = (alert.mock.calls[0] as unknown as [{ text: string }])[0];
	expect(sent.text).toContain("did not name the limit");
	expect(sent.text).not.toContain("account resource limit");
});
