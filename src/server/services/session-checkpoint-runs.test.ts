import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CheckpointRunClaim } from "../adapters/checkpoints/records";
import {
	CHECKPOINT_MAX_ACTIVE_RUNS,
	CHECKPOINT_STARTS_PER_TICK,
	runSessionCheckpoints,
} from "./session-checkpoint";

const sessions = ["a", "b", "c", "d", "e"].map((id) => ({
	user_id: "u1",
	id,
}));

/** An in-memory lease table with the same rules as claimSessionCheckpointRun. */
function leases(maxActive = CHECKPOINT_MAX_ACTIVE_RUNS) {
	const held = new Map<string, string>();
	return {
		held,
		claim: async (
			sessionId: string,
			leaseId: string,
		): Promise<CheckpointRunClaim> => {
			if (held.has(sessionId)) return { kind: "busy" };
			if (held.size >= maxActive) return { kind: "busy" };
			held.set(sessionId, leaseId);
			return { kind: "claimed", leaseId };
		},
		release: async (sessionId: string, leaseId: string) => {
			if (held.get(sessionId) === leaseId) held.delete(sessionId);
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("never runs two captures for one session across overlapping ticks", async () => {
	const table = leases();
	const running = new Map<string, number>();
	let peak = 0;
	const capture = async (_user: string, sessionId: string) => {
		running.set(sessionId, (running.get(sessionId) ?? 0) + 1);
		peak = Math.max(peak, running.get(sessionId) ?? 0);
		await new Promise((resolve) => setTimeout(resolve, 90_000));
		running.set(sessionId, (running.get(sessionId) ?? 1) - 1);
	};
	const deps = {
		...table,
		capture,
		recordFailure: async () => {},
	};
	// A tick every minute while each capture takes 90 s.
	const first = runSessionCheckpoints(sessions, deps);
	await vi.advanceTimersByTimeAsync(60_000);
	const second = runSessionCheckpoints(sessions, deps);
	await vi.advanceTimersByTimeAsync(60_000);
	const third = runSessionCheckpoints(sessions, deps);
	await vi.advanceTimersByTimeAsync(200_000);
	await Promise.all([first, second, third]);
	expect(peak).toBe(1);
});

it("starts at most the per-tick and fleet-wide limits", async () => {
	const table = leases();
	const started: string[] = [];
	const deps = {
		...table,
		capture: async (_user: string, sessionId: string) => {
			started.push(sessionId);
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		},
		recordFailure: async () => {},
	};
	const tick = runSessionCheckpoints(sessions, deps);
	await vi.advanceTimersByTimeAsync(10_000);
	expect((await tick).started).toBe(CHECKPOINT_STARTS_PER_TICK);
	expect(started).toHaveLength(CHECKPOINT_STARTS_PER_TICK);
	expect(table.held.size).toBe(0);
});

it("gives up on a run past its limit, backs the session off and keeps its lease", async () => {
	const table = leases();
	const failures: [string, string][] = [];
	const tick = runSessionCheckpoints(sessions.slice(0, 1), {
		...table,
		limitMs: 5_000,
		capture: async (_user, _session, progress) => {
			progress.stage = "export";
			await new Promise<never>(() => {});
		},
		recordFailure: async (sessionId, stage) => {
			failures.push([sessionId, stage]);
		},
	});
	await vi.advanceTimersByTimeAsync(5_000);
	await tick;
	expect(failures).toEqual([["a", "export"]]);
	// The hung capture's lease is left to expire, so no second run starts on it.
	expect(table.held.has("a")).toBe(true);
});

it("releases the lease when a capture fails, and reports sessions it could not lease", async () => {
	const table = leases();
	await runSessionCheckpoints(sessions.slice(0, 1), {
		...table,
		capture: async () => {
			throw new Error("capture failed");
		},
		recordFailure: async () => {},
	});
	expect(table.held.size).toBe(0);
	const result = await runSessionCheckpoints(sessions.slice(0, 2), {
		claim: async () => ({ kind: "unavailable" }),
		release: async () => {},
		capture: async () => {},
		recordFailure: async () => {},
	});
	expect(result.started).toBe(0);
	expect(result.unavailable.map((session) => session.id)).toEqual(["a", "b"]);
});
