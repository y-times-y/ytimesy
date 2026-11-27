import { describe, expect, it } from "vitest";
import {
	PLAN_WAKE_STOP_PERCENT,
	planBlocksWake,
	welcomeOnlyText,
	Y_SQUARED_WELCOME,
	Y_WAKES_PER_USER_PER_DAY,
} from "./y-default";

const usage = (status: string, used: number) => ({
	status,
	resetsAt: null,
	readAt: 0,
	windows: [{ id: "5h" as const, usedPercent: used, resetsAt: null }],
});

describe("a Y² wake and the person's plan", () => {
	it("skips when the plan is rejected or nearly full, never when there is no reading", () => {
		expect(planBlocksWake(null)).toBe(false);
		expect(planBlocksWake(usage("allowed", 10))).toBe(false);
		expect(planBlocksWake(usage("allowed", PLAN_WAKE_STOP_PERCENT))).toBe(true);
		expect(planBlocksWake(usage("rejected", 0))).toBe(true);
	});
	it("recognises a chat holding only the seeded welcome", () => {
		const welcome = {
			id: "welcome-1",
			kind: "agentMessage",
			text: Y_SQUARED_WELCOME,
		};
		expect(welcomeOnlyText([welcome])).toBe(Y_SQUARED_WELCOME);
		expect(welcomeOnlyText([])).toBeNull();
		expect(
			welcomeOnlyText([welcome, { id: "u1", kind: "userMessage", text: "hi" }]),
		).toBeNull();
		expect(
			welcomeOnlyText([{ id: "m1", kind: "agentMessage", text: "Done" }]),
		).toBeNull();
	});
	it("has a short welcome and a per-user daily cap", () => {
		expect(Y_SQUARED_WELCOME.length).toBeLessThan(260);
		expect(Y_SQUARED_WELCOME).toMatch(/keep track of its threads/);
		expect(Y_WAKES_PER_USER_PER_DAY).toBe(600);
	});
});
