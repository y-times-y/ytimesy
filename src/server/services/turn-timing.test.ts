import { expect, it } from "vitest";
import { turnTiming, turnTimingLine } from "./turn-timing";

it("formats one line of ids, numbers and fixed codes", () => {
	expect(
		JSON.parse(
			turnTimingLine({
				turnId: "turn-1",
				step: 1,
				startedAt: 10_500,
				queuedAt: 10_000,
				early: false,
				earlyReason: "hook-config-unknown",
				outcome: "completed",
				phases: { leaseAcquired: 12, firstToken: 2100 },
			}),
		),
	).toEqual({
		ytimesy: "turn-timing",
		turn: "turn-1",
		step: 1,
		queuedMs: 500,
		early: false,
		earlyReason: "hook-config-unknown",
		outcome: "completed",
		phases: { leaseAcquired: 12, firstToken: 2100 },
	});
});

it("leaves out what it does not know", () => {
	expect(
		JSON.parse(
			turnTimingLine({ turnId: "t", step: 2, startedAt: 1, phases: {} }),
		),
	).toEqual({ ytimesy: "turn-timing", turn: "t", step: 2, phases: {} });
});

it("keeps each phase's first mark and the first early decision, and writes once", () => {
	let clock = 1_000;
	const lines: string[] = [];
	const timing = turnTiming({
		turnId: "t",
		step: 1,
		startedAt: 1_000,
		now: () => clock,
	});
	clock = 1_040.4;
	timing.mark("leaseAcquired");
	clock = 1_090;
	timing.mark("leaseAcquired");
	timing.early(true, "early");
	timing.early(false, "workspace-ready");
	clock = 1_300;
	timing.write("completed", (line) => lines.push(line));
	timing.write("failed", (line) => lines.push(line));
	expect(lines).toHaveLength(1);
	expect(JSON.parse(lines[0])).toMatchObject({
		early: true,
		earlyReason: "early",
		outcome: "completed",
		phases: { leaseAcquired: 40, end: 300 },
	});
});
