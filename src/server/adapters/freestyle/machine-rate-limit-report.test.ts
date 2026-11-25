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
