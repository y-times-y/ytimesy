import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { checkerPairGate } from "./checker-pair-gate";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

const judge = {
	id: "judge",
	userId: "user",
	parentSessionId: "root",
	agentRole: "checker",
	turnStatus: "running",
	createdAt: at(-120),
	updatedAt: at(-1),
	items: [],
} as unknown as AgentSessionRecord;

const worker = (fields: Partial<AgentSessionRecord>) =>
	({
		id: "worker",
		userId: "user",
		parentSessionId: "judge",
		agentRole: "researcher",
		title: "Checker worker",
		createdAt: at(-100),
		updatedAt: at(-90),
		items: [],
		...fields,
	}) as unknown as AgentSessionRecord;

const event = (pending: boolean) => ({
	id: "event-1",
	userId: "user",
	parentSessionId: "judge",
	childSessionId: "worker",
	eventType: "completed" as const,
	payload: { message: "[agent 1.1 researcher finished] make test: exit 0" },
	attempts: 0,
	pending,
});

function gate(input: {
	workers: AgentSessionRecord[][];
	events?: ReturnType<typeof event>[];
	waitUntil?: number;
}) {
	let now = NOW;
	let call = 0;
	const deps = {
		now: () => now,
		sleep: vi.fn(async (ms: number) => {
			now += ms;
		}),
		workers: vi.fn(
			async () =>
				input.workers[Math.min(call++, input.workers.length - 1)] ?? [],
		),
		reportEvents: vi.fn(async () => input.events ?? []),
		stage: vi.fn(async () => {}),
	};
	return {
		deps,
		run: () =>
			checkerPairGate({
				judge,
				signal: new AbortController().signal,
				waitUntil: input.waitUntil ?? NOW + 60_000,
				deps: deps as never,
			}),
	};
}

describe("checker pair gate", () => {
	it("lets a judge without workers call its model at once", async () => {
		const { run, deps } = gate({ workers: [[]] });
		expect(await run()).toBe("ready");
		expect(deps.sleep).not.toHaveBeenCalled();
	});

	it("holds the judge while its worker works, then stages the report in its mailbox", async () => {
		const working = worker({ turnStatus: "running", updatedAt: at(-1) });
		const done = worker({ turnStatus: "completed", updatedAt: at(5) });
		const h = gate({ workers: [[working], [working], [done]] });
		h.deps.reportEvents
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValue([event(true)]);
		expect(await h.run()).toBe("ready");
		expect(h.deps.sleep).toHaveBeenCalledTimes(2);
		expect(h.deps.stage).toHaveBeenCalledWith(
			"judge",
			"event-1",
			expect.stringContaining("make test: exit 0"),
		);
	});

	it("ends the step with wait when the worker still works at the deadline", async () => {
		const working = worker({ turnStatus: "running", updatedAt: at(-1) });
		const h = gate({ workers: [[working]], waitUntil: NOW + 10_000 });
		expect(await h.run()).toBe("wait");
		expect(h.deps.stage).not.toHaveBeenCalled();
	});

	it("waits briefly for a just-finished worker's report, never for a taken one", async () => {
		const justDone = worker({ turnStatus: "completed", updatedAt: at(-5) });
		expect(
			await gate({ workers: [[justDone]], waitUntil: NOW + 3_000 }).run(),
		).toBe("wait");
		const taken = gate({ workers: [[justDone]], events: [event(false)] });
		expect(await taken.run()).toBe("ready");
		expect(taken.deps.stage).not.toHaveBeenCalled();
		const old = worker({ turnStatus: "completed", updatedAt: at(-120) });
		expect(await gate({ workers: [[old]] }).run()).toBe("ready");
	});
});
