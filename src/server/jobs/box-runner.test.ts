import { describe, expect, it, vi } from "vitest";
import type { ApiTurn } from "../adapters/api-turns";
import type { WorkspaceMachines } from "../services/workspace-machines";

vi.mock("./api-turn", () => ({ runApiTurn: vi.fn() }));
vi.mock("./conversation-delivery", () => ({
	relayConversationDeliveriesOnce: vi.fn(async () => undefined),
}));

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
	const pause = vi.fn(async () => undefined);
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
