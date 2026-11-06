import { describe, expect, it } from "vitest";
import {
	deferralDelayMs,
	heldJobWeight,
	ISOLATE_JOB_BUDGET,
	jobWeight,
	PEER_DEADLINE_MS,
	peerDeadlineReached,
	peerRetryDelayMs,
	tryAdmitJob,
} from "./background-job-admission";

describe("isolate job admission", () => {
	it("runs light kinds without holding any budget", () => {
		const release = tryAdmitJob("task-event");
		expect(release).not.toBeNull();
		expect(heldJobWeight()).toBe(0);
		release?.();
	});

	it("never holds more than the budget once something is running", () => {
		const held: (() => void)[] = [];
		let peak = 0;
		let deferred = 0;
		for (let index = 0; index < 20; index++) {
			const release = tryAdmitJob("checkpoint");
			if (release) held.push(release);
			else deferred++;
			peak = Math.max(peak, heldJobWeight());
		}
		// 20 simultaneous checkpoints: one runs, nineteen wait on alarms.
		expect(held).toHaveLength(1);
		expect(deferred).toBe(19);
		expect(peak).toBeLessThanOrEqual(ISOLATE_JOB_BUDGET);
		for (const release of held) release();
		expect(heldJobWeight()).toBe(0);
	});

	it("lets a checkpoint and a memory job share, but not two checkpoints", () => {
		const checkpoint = tryAdmitJob("checkpoint");
		const memory = tryAdmitJob("memory");
		expect(checkpoint).not.toBeNull();
		expect(memory).not.toBeNull();
		expect(tryAdmitJob("checkpoint")).toBeNull();
		expect(tryAdmitJob("memory")).toBeNull();
		memory?.();
		checkpoint?.();
		expect(heldJobWeight()).toBe(0);
	});

	it("admits three memory jobs and defers the fourth", () => {
		const releases = [1, 2, 3].map(() => tryAdmitJob("memory"));
		expect(releases.every(Boolean)).toBe(true);
		expect(tryAdmitJob("memory")).toBeNull();
		for (const release of releases) release?.();
		expect(heldJobWeight()).toBe(0);
	});

	it("releases once, however often it is called", () => {
		const release = tryAdmitJob("memory");
		release?.();
		release?.();
		expect(heldJobWeight()).toBe(0);
	});

	it("a job heavier than the budget still runs alone", () => {
		expect(jobWeight("checkpoint")).toBeLessThanOrEqual(ISOLATE_JOB_BUDGET);
		const release = tryAdmitJob("checkpoint");
		expect(release).not.toBeNull();
		release?.();
	});

	it("spreads deferrals between 3 and 8 seconds", () => {
		expect(deferralDelayMs(() => 0)).toBe(3000);
		expect(deferralDelayMs(() => 0.999)).toBeLessThan(8000);
	});
});

describe("peer retry schedule", () => {
	it("starts at 15 s and backs off to 60 s", () => {
		expect(peerRetryDelayMs(0)).toBe(15_000);
		expect(peerRetryDelayMs(7)).toBe(15_000);
		expect(peerRetryDelayMs(8)).toBe(30_000);
		expect(peerRetryDelayMs(20)).toBe(60_000);
	});

	it("gives up after the same hour as before, with far fewer wake-ups", () => {
		let attempts = 0;
		while (!peerDeadlineReached(attempts)) attempts++;
		let waited = 0;
		for (let attempt = 0; attempt < attempts; attempt++)
			waited += peerRetryDelayMs(attempt);
		expect(waited).toBeGreaterThanOrEqual(PEER_DEADLINE_MS);
		expect(waited - PEER_DEADLINE_MS).toBeLessThan(60_000);
		// 240 alarms before; the backoff needs about 73.
		expect(attempts).toBeLessThan(80);
	});
});
