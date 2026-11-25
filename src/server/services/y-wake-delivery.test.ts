import { describe, expect, it } from "vitest";
import {
	CLAUDE_CODE_MODELS,
	claudeCodeRouteId,
} from "#/domain/claude-code-route";
import {
	deliverY2Wake,
	STEERED_WAKE_NOTE,
	type WakeDeliveryDeps,
} from "./y-wake-delivery";

const CLAUDE = claudeCodeRouteId(CLAUDE_CODE_MODELS[0]?.id ?? "");

function setup(
	over: { busyFor?: number; gateModel?: string; staged?: boolean } = {},
) {
	const calls = { gate: 0, staged: [] as string[], sent: 0, unstaged: 0 };
	let busyReads = 0;
	const deps: WakeDeliveryDeps = {
		gate: async () => {
			calls.gate++;
			return { ok: true, harnessId: "api", modelId: over.gateModel ?? "gpt-x" };
		},
		// busy for the first `busyFor` reads, then idle (the turn ended)
		busy: async () => busyReads++ < (over.busyFor ?? 0),
		stage: async (_id, message) => {
			calls.staged.push(message);
		},
		accepted: async () => false,
		unstage: async () => {
			calls.unstaged++;
		},
		send: async () => {
			calls.sent++;
		},
	};
	return { deps, calls };
}
const input = (model: string | null) => ({
	target: { sessionId: "y2" },
	at: 1,
	body: "BODY",
	chat: { harness: "api", listedModelId: model, turnStatus: null },
});

describe("a wake into Y²", () => {
	it("starts a turn at once when Y² is idle", async () => {
		const { deps, calls } = setup();
		expect(await deliverY2Wake(deps, input("gpt-x"))).toBe(true);
		expect(calls).toMatchObject({ sent: 1, staged: [] });
	});

	it("steers into the running turn when Y² is mid-turn: no new turn, no queue", async () => {
		const { deps, calls } = setup({ busyFor: 2 });
		expect(await deliverY2Wake(deps, input("gpt-x"))).toBe(true);
		expect(calls.sent).toBe(0);
		expect(calls.staged).toHaveLength(1);
		expect(calls.staged[0]).toContain(STEERED_WAKE_NOTE);
		expect(calls.staged[0]).toContain("BODY");
	});

	it("takes a steer back and starts a turn when the turn ended before its step read it", async () => {
		const { deps, calls } = setup({ busyFor: 1 });
		expect(await deliverY2Wake(deps, input("gpt-x"))).toBe(true);
		expect(calls).toMatchObject({ unstaged: 1, sent: 1 });
	});

	it("holds (and spends no daily wake) when a Claude plan run is mid-turn, queues once held too long", async () => {
		const { deps, calls } = setup({ busyFor: 9, gateModel: CLAUDE });
		expect(await deliverY2Wake(deps, input(CLAUDE))).toEqual({ held: "busy" });
		expect(calls.gate).toBe(0);
		expect(
			await deliverY2Wake(deps, { ...input(CLAUDE), queueBehind: true }),
		).toBe(true);
		expect(calls).toMatchObject({ sent: 1, staged: [] });
	});

	it("stays dormant: a skipped gate neither steers nor sends", async () => {
		const { deps, calls } = setup({ busyFor: 2 });
		deps.gate = async () => ({ ok: false, reason: "no-model" });
		expect(await deliverY2Wake(deps, input("gpt-x"))).toEqual({
			skipped: "no-model",
		});
		expect(calls).toMatchObject({ sent: 0, staged: [] });
	});
});
