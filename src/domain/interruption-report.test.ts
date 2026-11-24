import { expect, it } from "vitest";
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
