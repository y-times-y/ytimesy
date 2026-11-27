import { describe, expect, it, vi } from "vitest";
import type { ApiTurn } from "../adapters/api-turns";
import type { WorkspaceMachines } from "../services/workspace-machines";

vi.mock("./api-turn", () => ({ runApiTurn: vi.fn() }));
vi.mock("./conversation-delivery", () => ({
	relayConversationDeliveriesOnce: vi.fn(async () => undefined),
}));

import { CoordinationFailure } from "#/domain/conversation-turn-control";
import { TRANSIENT_RETRY_WINDOW_MS } from "#/domain/turn-interruption";
import { MAX_BOX_STEP_RETRIES, runBoxTurn } from "./box-runner";

const machines = {} as WorkspaceMachines;
const turn = (extra: Partial<ApiTurn> = {}) =>
	({
		id: "t1",
		session_id: "s1",
		user_id: "u1",
		lease_id: "lease-1",
		state: "running",
		messages: [],
		items: [],
		...extra,
	}) as ApiTurn;

const deps = (
	runs: (() => Promise<unknown>)[],
	rereads: (ApiTurn | null)[] = [],
) => {
	const calls: { index: number; resumed?: boolean }[] = [];
	const run = vi.fn(
		async (
			_m: unknown,
			_t: unknown,
			step: { index: number; resumed?: boolean },
		) => {
			calls.push({ index: step.index, resumed: step.resumed });
			return (await (runs.shift() as () => Promise<unknown>)()) as never;
		},
	);
	const reread = vi.fn(
		async () => (rereads.length ? rereads.shift() : turn()) as ApiTurn | null,
	);
	const abandon = vi.fn(async () => true);
	const pause = vi.fn(async (_ms: number) => undefined);
	return {
		calls,
		d: { run, reread, abandon, pause } as never,
		abandon,
		pause,
		run,
	};
};

describe("runBoxTurn", () => {
	it("runs the turn as one step and returns its outcome", async () => {
		const { calls, d } = deps([async () => "completed"]);
		await expect(runBoxTurn(machines, turn(), d)).resolves.toBe("completed");
		expect(calls).toEqual([{ index: 1, resumed: false }]);
	});

	it("starts a turn another box lost as a resumed step", async () => {
		const { calls, d } = deps([async () => "completed"]);
		await runBoxTurn(machines, turn({ run_attempts: 1 }), d);
		expect(calls[0]?.resumed).toBe(true);
	});

	it("reads the turn again and goes on when a step continues it", async () => {
		const next = turn({
			items: [{ kind: "agentMessage", id: "a", text: "x" }] as never,
		});
		const { calls, d, run } = deps(
			[async () => "continue", async () => "completed"],
			[next],
		);
		await expect(runBoxTurn(machines, turn(), d)).resolves.toBe("completed");
		expect(calls).toEqual([
			{ index: 1, resumed: false },
			{ index: 2, resumed: false },
		]);
		expect(run.mock.calls[1]?.[1]).toBe(next);
	});

	it("retries a step that throws as a resumed one, and fails the turn after too many", async () => {
		const boom = () => Promise.reject(new Error("socket closed"));
		const ok = deps([boom, async () => "completed"]);
		await expect(runBoxTurn(machines, turn(), ok.d)).resolves.toBe("completed");
		expect(ok.calls.map((call) => call.resumed)).toEqual([false, true]);
		expect(ok.pause).toHaveBeenCalledWith(5_000);

		const bad = deps(
			Array.from({ length: MAX_BOX_STEP_RETRIES + 1 }, () => boom),
		);
		await expect(runBoxTurn(machines, turn(), bad.d)).rejects.toThrow(
			"socket closed",
		);
		expect(bad.abandon).toHaveBeenCalledWith("t1", "lease-1");
		expect(bad.run).toHaveBeenCalledTimes(MAX_BOX_STEP_RETRIES + 1);
	});

	it("rides out a 10-minute coordinator outage with backoff and completes the turn (fault injection)", async () => {
		const outage = () =>
			Promise.reject(
				new CoordinationFailure(
					"renew",
					{ kind: "transport", category: "timeout" },
					3,
				),
			);
		const runs = [
			...Array.from({ length: 12 }, () => outage),
			async () => "completed",
		];
		const clock = vi.spyOn(Date, "now");
		let now = 1_000_000;
		clock.mockImplementation(() => now);
		try {
			const d = deps(runs);
			d.pause.mockImplementation(async (ms: number) => {
				now += ms;
			});
			await expect(runBoxTurn(machines, turn(), d.d)).resolves.toBe(
				"completed",
			);
			expect(d.abandon).not.toHaveBeenCalled();
			expect(d.run).toHaveBeenCalledTimes(13);
			// Backoff grows to its cap; every retry after the first is a resumed step.
			const waits = d.pause.mock.calls.map((call) => call[0]);
			expect(waits.slice(0, 5)).toEqual([
				5_000, 10_000, 20_000, 40_000, 60_000,
			]);
			expect(Math.max(...waits)).toBe(60_000);
			expect(now - 1_000_000).toBeGreaterThan(60_000 * 5);
		} finally {
			clock.mockRestore();
		}
	});

	it("gives up on an outage only after the whole window, and then fails the turn", async () => {
		const clock = vi.spyOn(Date, "now");
		let now = 0;
		clock.mockImplementation(() => now);
		try {
			const outage = () =>
				Promise.reject(
					Object.assign(new Error("x"), {
						name: "TurnBoxVmRefused",
						status: 503,
					}),
				);
			const d = deps(Array.from({ length: 100 }, () => outage));
			d.pause.mockImplementation(async (ms: number) => {
				now += ms;
			});
			await expect(runBoxTurn(machines, turn(), d.d)).rejects.toThrow();
			expect(now).toBeGreaterThanOrEqual(TRANSIENT_RETRY_WINDOW_MS - 60_000);
			expect(d.abandon).toHaveBeenCalledOnce();
		} finally {
			clock.mockRestore();
		}
	});

	it("does not retry a turn it no longer owns (stopped, finished, taken over)", async () => {
		const lost = deps([() => Promise.reject(new Error("lease lost"))], [null]);
		await expect(runBoxTurn(machines, turn(), lost.d)).rejects.toThrow(
			"lease lost",
		);
		expect(lost.run).toHaveBeenCalledTimes(1);
		expect(lost.abandon).not.toHaveBeenCalled();
		// A turn that ended between steps is not run again either.
		const ended = deps([async () => "continue"], [null]);
		await expect(runBoxTurn(machines, turn(), ended.d)).resolves.toBe(
			"unavailable",
		);
		await expect(
			runBoxTurn(machines, turn({ lease_id: null }), ended.d),
		).resolves.toBe("unavailable");
	});
});

describe("a box turn that is abandoned never leaves the transcript silent (canary 2026-11-27 17:00)", () => {
	it("finalizes failed with a calm error item the chat can show", async () => {
		const { edgeTurnDeps } = await import("./box-runner");
		const finalize = vi.fn(async () => "failed" as const);
		const session = {
			turn: { id: "t1", session_id: "s1", user_id: "u1", lease_id: "lease-1" },
			history: async () => ({
				messages: [],
				items: [{ kind: "userMessage", id: "m1", text: "hi" }],
			}),
			savedHistory: () => null,
			finalize,
		};
		const deps = edgeTurnDeps(session as never, {} as never, vi.fn() as never);
		await expect(deps.abandon()).resolves.toBe(true);
		const [state, items] = finalize.mock.calls[0] as unknown as [
			string,
			{ kind: string; id: string; message?: string }[],
		];
		expect(state).toBe("failed");
		const error = items.find((item) => item.kind === "error");
		expect(error?.id).toBe("t1:lost");
		expect(error?.message).toMatch(/saved/i);
		expect(items[0]?.kind).toBe("userMessage");
	});

	it("does not add a second notice when the history already ends in an error", async () => {
		const { edgeTurnDeps } = await import("./box-runner");
		const finalize = vi.fn(async () => "failed" as const);
		const session = {
			turn: { id: "t1", session_id: "s1", user_id: "u1", lease_id: "lease-1" },
			history: async () => ({
				messages: [],
				items: [
					{ kind: "userMessage", id: "m1", text: "hi" },
					{ kind: "error", id: "t1:error", message: "x" },
				],
			}),
			savedHistory: () => null,
			finalize,
		};
		const deps = edgeTurnDeps(session as never, {} as never, vi.fn() as never);
		await deps.abandon();
		const items = (finalize.mock.calls[0] as unknown as [string, unknown[]])[1];
		expect(
			items.filter((i) => (i as { kind: string }).kind === "error"),
		).toHaveLength(1);
	});
});
