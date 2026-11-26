import { describe, expect, it } from "vitest";
import {
	dailyInterruptionReport,
	interruptionDigestText,
	interruptionRateLimited,
} from "./interruption-report";

const row = (
	at: string,
	kind: string,
	cause: string,
	user_visible = false,
	recovered = false,
) => ({ at, kind, cause, user_visible, recovered });

const rows = [
	row("2026-11-23T10:00:00Z", "turn.interrupted", "reset", false, true),
	row("2026-11-24T01:00:00Z", "turn.interrupted", "reset", false, true),
	row("2026-11-24T02:00:00Z", "turn.interrupted", "connection", false, true),
	row("2026-11-24T23:59:00Z", "turn-abandoned", "lease-expired", true),
];

it("counts by kind, cause and user-visible per UTC day", () => {
	const days = dailyInterruptionReport(rows);
	expect(days.map((d) => d.day)).toEqual(["2026-11-23", "2026-11-24"]);
	expect(days[1]).toMatchObject({
		total: 3,
		userVisible: 1,
		recovered: 2,
		byKind: { "turn.interrupted": 2, "turn-abandoned": 1 },
		byCause: {
			"turn.interrupted/reset": 1,
			"turn.interrupted/connection": 1,
			"turn-abandoned/lease-expired": 1,
		},
	});
});

it("returns nothing for no rows and renders a zero day", () => {
	expect(dailyInterruptionReport([])).toEqual([]);
	expect(interruptionDigestText([], "2026-11-24")).toContain(
		"2026-11-24 (UTC): 0, user-visible: 0",
	);
});

it("renders the digest with earlier days and canary", () => {
	const text = interruptionDigestText(
		dailyInterruptionReport(rows),
		"2026-11-24",
		{ runs: 48, failures: 1 },
	);
	expect(text).toContain("3, user-visible: 1, recovered: 2");
	expect(text).toContain("1  turn-abandoned/lease-expired");
	expect(text).toContain("2026-11-23  1 / 0");
	expect(text).toContain("Canary: 48 runs, 1 failed.");
});

it("rate limits inside the window only", () => {
	expect(interruptionRateLimited(undefined, 1000)).toBe(false);
	expect(interruptionRateLimited(1000, 2000)).toBe(true);
	expect(interruptionRateLimited(1000, 1000 + 11 * 60_000)).toBe(false);
});

it("lists the day's top causes with a hash of each chat and whether the cause is fixed", () => {
	const events = [
		{
			...row("2026-11-25T19:37:00Z", "turn-abandoned", "lease-expired", true),
			chat: "a1b2c3d4",
		},
		{
			...row("2026-11-25T19:37:01Z", "turn-abandoned", "lease-expired", true),
			chat: "a1b2c3d4",
		},
		{
			...row(
				"2026-11-25T23:30:00Z",
				"lease-takeover",
				"box-heartbeat-lost",
				false,
				true,
			),
			chat: "ffff0000",
		},
		{
			...row("2026-11-25T23:31:00Z", "lease-takeover", "mystery", false, true),
			chat: "11112222",
		},
	];
	const text = interruptionDigestText(
		dailyInterruptionReport(events),
		"2026-11-25",
		undefined,
		events,
	);
	expect(text).toContain("Top causes:");
	expect(text).toMatch(
		/2 {2}turn-abandoned\/lease-expired .*chats a1b2c3d4 .*fixed/,
	);
	expect(text).toMatch(
		/1 {2}lease-takeover\/box-heartbeat-lost .*chats ffff0000/,
	);
	expect(text).toMatch(
		/1 {2}lease-takeover\/mystery .*chats 11112222 .*not fixed/,
	);
	expect(text).not.toContain("Top causes:\n  0");
});

describe("user-visible machine failure rate", () => {
	it("is per 1,000 turns, alerts above the target and says so in the digest", async () => {
		const r = await import("./interruption-report");
		expect(r.MACHINE_FAILURE_TARGET_PER_1000).toBe(1);
		expect(r.machineFailureRatePer1000(2, 1000)).toBe(2);
		expect(r.machineFailureRatePer1000(0, 0)).toBe(0);
		expect(r.machineFailureRateExceeded(1, 1000)).toBe(false);
		expect(r.machineFailureRateExceeded(2, 1000)).toBe(true);
		const text = r.interruptionDigestText([], "2026-11-25", undefined, [], {
			turns: 500,
			machineFailures: 2,
		});
		expect(text).toContain(
			"Machine start failures seen by users: 2 of 500 turns",
		);
		expect(text).toContain("ABOVE target");
	});
});

describe("canary watchdog", () => {
	const now = new Date("2026-11-26T12:00:00Z");
	const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
	it("is quiet while the canary ran within 90 minutes", async () => {
		const { canaryWatchdogProblem } = await import("./interruption-report");
		expect(
			canaryWatchdogProblem({ configured: true, lastRunAt: ago(35), now }),
		).toBeNull();
	});
	it("names a canary that has not run for 90 minutes, and one that lost its configuration", async () => {
		const { canaryWatchdogProblem } = await import("./interruption-report");
		expect(
			canaryWatchdogProblem({ configured: true, lastRunAt: ago(91), now }),
		).toMatch(/90 minutes/);
		expect(
			canaryWatchdogProblem({ configured: false, lastRunAt: ago(40), now }),
		).toMatch(/not configured/);
	});
	it("stays silent for a canary that was never set up", async () => {
		const { canaryWatchdogProblem } = await import("./interruption-report");
		expect(
			canaryWatchdogProblem({ configured: false, lastRunAt: null, now }),
		).toBeNull();
		expect(
			canaryWatchdogProblem({
				configured: false,
				lastRunAt: ago(24 * 60),
				now,
			}),
		).toBeNull();
	});
});
