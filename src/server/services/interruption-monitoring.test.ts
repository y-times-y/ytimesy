import { expect, it, vi } from "vitest";

vi.mock("../adapters/interruption-events", () => ({}));
vi.mock("../adapters/owner-alerts", () => ({ alertOwner: async () => "sent" }));

import { canaryPrompts } from "#/domain/canary-timeline";
import type { SessionItem } from "#/domain/session-item";
import {
	canaryConfig,
	reportInterruption,
	runCanaryStep,
	runInterruptionMonitoring,
	sendInterruptionDigest,
} from "./interruption-monitoring";

const now = new Date("2026-11-24T07:00:00Z");

it("alerts the owner once per hour key for a user-visible interruption", async () => {
	const alert = vi.fn(async () => "sent" as const);
	await reportInterruption(
		{ kind: "turn-abandoned", turnId: "t", userVisible: true },
		{ record: async () => "recorded", alert, now },
	);
	expect(alert).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "interruption", key: "2026-11-24T07" }),
	);
});

it("does not alert for hidden, limited, and survives failures", async () => {
	const alert = vi.fn(async () => "sent" as const);
	await reportInterruption(
		{ kind: "lease-takeover", userVisible: false },
		{ record: async () => "recorded", alert },
	);
	await reportInterruption(
		{ kind: "x", userVisible: true },
		{ record: async () => "limited", alert },
	);
	expect(alert).not.toHaveBeenCalled();
	await expect(
		reportInterruption(
			{ kind: "x", userVisible: true },
			{
				record: async () => {
					throw new Error("x");
				},
				alert,
			},
		),
	).resolves.toBeUndefined();
	// A failed write still alerts: the owner should hear about it.
	await reportInterruption(
		{ kind: "x", userVisible: true },
		{ record: async () => "failed", alert },
	);
	expect(alert).toHaveBeenCalledTimes(1);
});

it("sends yesterday's digest keyed by day", async () => {
	const alert = vi.fn(async () => "sent" as const);
	await sendInterruptionDigest(now, {
		rows: async () => [
			{
				at: "2026-11-23T10:00:00Z",
				kind: "turn.interrupted",
				cause: "reset",
				recovered: true,
				user_visible: false,
			},
		],
		canary: async () => ({ runs: 48, failures: 0 }),
		turns: async () => 500,
		alert,
		prune: async () => {},
	});
	expect(alert).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: "interruption-digest",
			key: "2026-11-23",
			subject: expect.stringContaining("1 interruptions"),
		}),
	);
});

it("runs the digest only in its hour and the canary only when configured", async () => {
	const digest = vi.fn(async () => {});
	const step = vi.fn(async () => "idle" as const);
	await runInterruptionMonitoring(new Date("2026-11-24T12:00:00Z"), null, {
		digest,
		step,
	});
	expect(digest).not.toHaveBeenCalled();
	expect(step).not.toHaveBeenCalled();
	await runInterruptionMonitoring(
		now,
		{
			config: canaryConfig({
				YTIMESY_CANARY_USER_ID: "u",
				YTIMESY_CANARY_PROJECT_ID: "p",
				YTIMESY_CANARY_MODEL_ID: "m",
			})!,
			send: async () => "s",
		},
		{ digest, step },
	);
	expect(digest).toHaveBeenCalledTimes(1);
	expect(step).toHaveBeenCalledTimes(1);
	// A throwing step never fails the tick.
	await expect(
		runInterruptionMonitoring(
			now,
			{
				config: { userId: "u", projectId: "p", modelId: "m" },
				send: async () => "s",
			},
			{
				digest,
				step: async () => {
					throw new Error("x");
				},
			},
		),
	).resolves.toBeUndefined();
});

it("is inert until all three canary variables are set", () => {
	expect(canaryConfig({})).toBeNull();
	expect(
		canaryConfig({
			YTIMESY_CANARY_USER_ID: "u",
			YTIMESY_CANARY_PROJECT_ID: "p",
		}),
	).toBeNull();
});

const config = { userId: "u", projectId: "p", modelId: "m" };
const user = (text: string) =>
	({ kind: "userMessage", id: text, text }) as SessionItem;
const agent = (text: string) =>
	({ kind: "agentMessage", id: text, text }) as SessionItem;

it("sends A then B on the half hour into the reused chat", async () => {
	const send = vi.fn(async (_t: string, s: string | null) => s ?? "new-chat");
	const start = vi.fn(async () => {});
	const half = new Date("2026-11-24T10:30:00Z");
	const result = await runCanaryStep(half, {
		config,
		send,
		start,
		pending: async () => null,
		lastSession: async () => "chat1",
		items: async () => [user("old")],
		nonce: () => "abc",
	});
	expect(result).toBe("sent");
	expect(send.mock.calls.map((c) => c[1])).toEqual(["chat1", "chat1"]);
	expect(start).toHaveBeenCalledWith({
		sessionId: "chat1",
		nonce: "abc",
		baselineItems: 1,
	});
});

it("sends nothing off the half hour", async () => {
	const send = vi.fn(async () => "x");
	expect(
		await runCanaryStep(new Date("2026-11-24T10:35:00Z"), {
			config,
			send,
			pending: async () => null,
		}),
	).toBe("idle");
	expect(send).not.toHaveBeenCalled();
});

const pendingRun = {
	id: "1",
	at: new Date("2026-11-24T10:30:00Z"),
	sessionId: "chat1",
	nonce: "abc",
	baselineItems: 0,
};
const p = canaryPrompts("abc");

it("passes a pending run once both answers are there", async () => {
	const finish = vi.fn(async () => {});
	const result = await runCanaryStep(new Date("2026-11-24T10:35:00Z"), {
		config,
		send: async () => "x",
		finish,
		pending: async () => pendingRun,
		items: async () => [
			user(p.first),
			user(p.second),
			agent("PONG-A-abc"),
			agent("PONG-B-abc"),
		],
	});
	expect(result).toBe("passed");
	expect(finish).toHaveBeenCalledWith("1", null);
});

it("fails and alerts when an answer is still missing past the bound", async () => {
	const finish = vi.fn(async () => {});
	const alert = vi.fn(async () => "sent" as const);
	const result = await runCanaryStep(new Date("2026-11-24T10:45:00Z"), {
		config,
		send: async () => "x",
		finish,
		alert,
		pending: async () => pendingRun,
		items: async () => [user(p.first), user(p.second), agent("PONG-A-abc")],
	});
	expect(result).toBe("failed");
	expect(finish).toHaveBeenCalledWith(
		"1",
		expect.stringContaining("not answered"),
	);
	expect(alert).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "canary-failed", key: "2026-11-24T10" }),
	);
});

it("leaves a young run pending", async () => {
	expect(
		await runCanaryStep(new Date("2026-11-24T10:32:00Z"), {
			config,
			send: async () => "x",
			pending: async () => pendingRun,
			items: async () => [user(p.first)],
		}),
	).toBe("pending");
});

it("alerts the owner when user-visible machine failures exceed 1 per 1,000 turns", async () => {
	const alert = vi.fn(async () => "sent" as const);
	await sendInterruptionDigest(now, {
		rows: async () => [
			{
				at: "2026-11-23T10:00:00Z",
				kind: "machine-start-failed",
				cause: "ladder-exhausted",
				recovered: false,
				user_visible: true,
			},
		],
		canary: async () => ({ runs: 48, failures: 0 }),
		turns: async () => 500,
		alert,
		prune: async () => {},
	});
	expect(alert).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: "machine-failure-rate",
			key: "2026-11-23",
		}),
	);
});
