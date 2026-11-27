import { expect, it } from "vitest";
import { turnStallLimits } from "./turn-stall";

it("defaults to 4 minutes for the first output and 10 between events", () => {
	expect(turnStallLimits({})).toEqual({
		firstOutputSeconds: 240,
		betweenOutputSeconds: 600,
	});
});
it("reads overrides and ignores nonsense", () => {
	expect(
		turnStallLimits({
			YTIMESY_TURN_FIRST_OUTPUT_STALL_SECONDS: "120",
			YTIMESY_TURN_OUTPUT_STALL_SECONDS: "5",
		}),
	).toEqual({ firstOutputSeconds: 120, betweenOutputSeconds: 600 });
});
