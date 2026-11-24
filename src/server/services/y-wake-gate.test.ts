import { describe, expect, it, vi } from "vitest";
import { NoModelConnectedError } from "./linked-chat-route";
import { type WakeGateDeps, yWakeGate } from "./y-wake-gate";

const input = { userId: "u", harnessId: "api" as const, listedModelId: null };
const deps = (over: Partial<WakeGateDeps> = {}): WakeGateDeps => ({
	route: vi.fn(async () => ({ harnessId: "api" as const, modelId: "m" })),
	claudePlanUsage: vi.fn(async () => null),
	consumeWake: vi.fn(async () => true),
	...over,
});

describe("the Y² wake gate", () => {
	it("is dormant with no connected model: no cap used, no error", async () => {
		const d = deps({
			route: vi.fn(async () => {
				throw new NoModelConnectedError();
			}),
		});
		expect(await yWakeGate(input, d)).toEqual({
			ok: false,
			reason: "no-model",
		});
		expect(d.consumeWake).not.toHaveBeenCalled();
	});

	it("runs on the user's own connected model", async () => {
		expect(await yWakeGate(input, deps())).toEqual({
			ok: true,
			harnessId: "api",
			modelId: "m",
		});
	});

	it("skips quietly while the Claude plan is nearly exhausted, without using the cap", async () => {
		const d = deps({
			route: vi.fn(async () => ({
				harnessId: "api" as const,
				modelId: "claude-code/claude-opus-5-5",
			})),
			claudePlanUsage: vi.fn(async () => ({
				status: "allowed_warning",
				resetsAt: null,
				readAt: 0,
				windows: [{ id: "5h" as const, usedPercent: 97, resetsAt: null }],
			})),
		});
		expect(await yWakeGate(input, d)).toEqual({
			ok: false,
			reason: "plan-nearly-exhausted",
		});
		expect(d.consumeWake).not.toHaveBeenCalled();
	});

	it("stops at the user's daily cap", async () => {
		expect(
			await yWakeGate(input, deps({ consumeWake: vi.fn(async () => false) })),
		).toEqual({ ok: false, reason: "user-daily-cap" });
	});
});
