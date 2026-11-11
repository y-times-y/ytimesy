import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	JobTimeLimitReached,
	runWithJobTimeLimit,
} from "./background-job-time-limit";

const job = { id: "job-1", kind: "checkpoint" };
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("returns a run that finishes in time, without logging a fast one", async () => {
	await expect(runWithJobTimeLimit(job, async () => "delivered")).resolves.toBe(
		"delivered",
	);
	expect(console.warn).not.toHaveBeenCalled();
});

it("gives up on a run that never answers, and logs its kind", async () => {
	const waiting = runWithJobTimeLimit(job, () => new Promise<never>(() => {}), {
		limitMs: 1_000,
		slowMs: 500,
		now: () => Date.now(),
	});
	const assertion = expect(waiting).rejects.toBeInstanceOf(JobTimeLimitReached);
	await vi.advanceTimersByTimeAsync(1_000);
	await assertion;
	expect(console.warn).toHaveBeenCalledWith(
		"Background job ran long.",
		expect.objectContaining({ kind: "checkpoint", outcome: "time-limit" }),
	);
});

it("logs a slow run that does finish, and keeps its error when it fails", async () => {
	const slow = runWithJobTimeLimit(
		job,
		() => new Promise((resolve) => setTimeout(() => resolve("pending"), 800)),
		{ limitMs: 5_000, slowMs: 500, now: () => Date.now() },
	);
	await vi.advanceTimersByTimeAsync(800);
	await expect(slow).resolves.toBe("pending");
	expect(console.warn).toHaveBeenCalledWith(
		"Background job ran long.",
		expect.objectContaining({ outcome: "finished" }),
	);
	await expect(
		runWithJobTimeLimit(job, async () => {
			throw new TypeError("boom");
		}),
	).rejects.toThrow("boom");
});

it("does not leave its timer behind", async () => {
	await runWithJobTimeLimit(job, async () => "ok");
	expect(vi.getTimerCount()).toBe(0);
});
