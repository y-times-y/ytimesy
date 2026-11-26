import { describe, expect, it } from "vitest";
import {
	isMachineUnavailable,
	STALL_PROBE_AFTER_MS,
	shouldProbeLongCall,
	totalProbeWaitMs,
} from "./machine-health";

describe("machine health", () => {
	it("recognises a busy or restarting machine by its failures", () => {
		for (const message of [
			"Internal server error",
			"Tool call failed: Internal server error If this was a write",
			"The edge refused the workspace request (unavailable).",
			"502 Bad Gateway",
			"fetch failed",
		])
			expect(isMachineUnavailable(new Error(message))).toBe(true);
		expect(
			isMachineUnavailable(
				Object.assign(new Error("x"), {
					name: "TurnBoxVmRefused",
					status: 503,
				}),
			),
		).toBe(true);
	});
	it("does not treat a command's own failure or a refusal as the machine being down", () => {
		expect(isMachineUnavailable(new Error("npm ERR! code E404"))).toBe(false);
		expect(
			isMachineUnavailable(
				Object.assign(new Error("x"), {
					name: "TurnBoxVmRefused",
					status: 403,
				}),
			),
		).toBe(false);
		expect(isMachineUnavailable("Internal server error")).toBe(false);
	});
	it("probes a call only once it ran for 3 minutes, and waits about 3 minutes in all", () => {
		expect(shouldProbeLongCall(STALL_PROBE_AFTER_MS - 1)).toBe(false);
		expect(shouldProbeLongCall(STALL_PROBE_AFTER_MS)).toBe(true);
		expect(totalProbeWaitMs()).toBeGreaterThanOrEqual(150_000);
		expect(totalProbeWaitMs()).toBeLessThanOrEqual(240_000);
	});
});
