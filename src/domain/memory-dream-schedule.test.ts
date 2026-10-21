import { describe, expect, it } from "vitest";
import { memoryDreamSchedule } from "./memory-dream-schedule";

const base = {
	now: new Date("2026-10-21T18:02:00Z"),
	off: false,
	lastActivity: null,
	dreamedThrough: null,
	lastReview: null,
	idleMs: 15 * 60_000,
	tickMs: 5 * 60_000,
	reviewDays: 7,
};

describe("dream schedule", () => {
	it("waits for the next chat when nothing new happened since the last dream", () => {
		expect(
			memoryDreamSchedule({
				...base,
				lastActivity: new Date("2026-10-21T10:00:00Z"),
				dreamedThrough: new Date("2026-10-21T10:00:00Z"),
			}).next,
		).toEqual({ kind: "after-next-chat" });
		expect(memoryDreamSchedule(base).next).toEqual({ kind: "after-next-chat" });
	});

	it("runs on the first job tick after chats have been idle for the window", () => {
		expect(
			memoryDreamSchedule({
				...base,
				lastActivity: new Date("2026-10-21T17:58:00Z"),
				dreamedThrough: new Date("2026-10-21T09:00:00Z"),
			}).next,
		).toEqual({ kind: "soon", at: "2026-10-21T18:15:00.000Z" });
		// Already idle long enough: the next tick from now.
		expect(
			memoryDreamSchedule({
				...base,
				lastActivity: new Date("2026-10-21T16:00:00Z"),
			}).next,
		).toEqual({ kind: "soon", at: "2026-10-21T18:05:00.000Z" });
	});

	it("is paused while memory is off, and dates the weekly review from the last one", () => {
		const schedule = memoryDreamSchedule({
			...base,
			off: true,
			lastActivity: new Date("2026-10-21T16:00:00Z"),
			lastReview: new Date("2026-10-18T03:00:00Z"),
		});
		expect(schedule).toEqual({
			next: { kind: "off" },
			reviewDue: "2026-10-25T03:00:00.000Z",
		});
		expect(memoryDreamSchedule(base).reviewDue).toBeNull();
	});
});
