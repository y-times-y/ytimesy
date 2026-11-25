import { expect, it } from "vitest";
import { awakeReasonsEnabled, PendingTracker } from "./awake-reasons";

it("counts a promise until it settles, rejected or not", async () => {
	const tracker = new PendingTracker();
	const handed: Promise<unknown>[] = [];
	let resolve!: () => void;
	tracker.track(new Promise<void>((r) => (resolve = r)), (p) => handed.push(p));
	tracker.track(Promise.reject(new Error("x")), (p) => handed.push(p));
	expect(tracker.count).toBe(2);
	resolve();
	await Promise.all(handed);
	expect(tracker.count).toBe(0);
});

it("is off unless the variable is exactly 1", () => {
	expect(awakeReasonsEnabled(undefined)).toBe(false);
	expect(awakeReasonsEnabled("true")).toBe(false);
	expect(awakeReasonsEnabled("1")).toBe(true);
});
