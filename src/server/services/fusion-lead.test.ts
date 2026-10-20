import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import {
	beginSidekickRound,
	endSidekickRound,
	newSidekickState,
	type SidekickState,
} from "#/domain/sidekick";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	type FusionLeadDeps,
	fusionLeadGate,
	fusionRoundOpen,
	LEAD_WAITS_NOTICE,
	withSidekickWriteGuard,
} from "./fusion-lead";
import type { SubagentToolContext } from "./subagent-tools";

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const lead = {
	id: "lead",
	userId: "user",
	parentSessionId: null,
	title: "lead",
	turnStatus: "running",
	harness: "api",
	listedModelId: "gpt-6.1-sol",
	createdAt: at(-600_000),
	updatedAt: at(0),
	items: [],
} as unknown as AgentSessionRecord;

function sidekick(state: SidekickState, running: boolean) {
	return {
		...lead,
		id: "s",
		parentSessionId: "lead",
		title: "sidekick",
		turnStatus: running ? "running" : "completed",
		agentRole: "writer",
		agentBudget: {
			steps: 100,
			minutes: 30,
			tokens: 1_000_000,
			sidekick: state,
		},
	} as unknown as AgentSessionRecord;
}

const request: SessionItem[] = [
	{ kind: "userMessage", id: SessionItemId("u1"), text: "Add --json." },
];

/** A gate whose clock advances by each sleep; `world` changes as time passes. */
function gate(options: {
	children: (now: number) => AgentSessionRecord[];
	events?: (now: number) => Awaited<ReturnType<FusionLeadDeps["reportEvents"]>>;
	explore?: FusionLeadDeps["explore"];
	items?: SessionItem[];
	waitMs?: number;
	exploreFlag?: boolean;
}) {
	let now = T0;
	const deps = {
		now: () => now,
		sleep: vi.fn(async (ms: number) => {
			now += ms;
		}),
		children: vi.fn(async () => options.children(now)),
		reportEvents: vi.fn(async () => options.events?.(now) ?? []),
		stage: vi.fn(async () => {}),
		saveState: vi.fn(async () => {}),
		explore: options.explore ?? vi.fn(async () => ({ id: "1", round: 1 })),
	} satisfies FusionLeadDeps;
	const run = () =>
		fusionLeadGate({
			context: {
				parent: lead,
				signal: new AbortController().signal,
			} as unknown as SubagentToolContext,
			items: options.items ?? request,
			explore: options.exploreFlag ?? true,
			waitUntil: T0 + (options.waitMs ?? 60_000),
			deps,
		});
	return { deps, run, now: () => now };
}

const report = (id: string) => ({
	id,
	userId: "user",
	parentSessionId: "lead",
	childSessionId: "s",
	eventType: "completed" as const,
	payload: { message: "[agent 1 writer finished · round 1/6]\n\nFiles: a.ts" },
	attempts: 0,
	pending: true,
});

describe("fusion lead gate", () => {
	it("starts the request's exploration before the lead's first model call, then waits for its report", async () => {
		let started = false;
		const explore = vi.fn(async () => {
			started = true;
			return { id: "1", round: 1 };
		});
		const state = newSidekickState({ tokens: 1_000_000 }, at(0), {
			requestKey: "u1",
			kind: "explore",
		});
		const { deps, run } = gate({
			explore,
			// The sidekick explores for 20 s, then reports.
			children: (now) =>
				!started
					? []
					: now - T0 < 20_000
						? [sidekick(state, true)]
						: [
								sidekick(
									endSidekickRound(state, {
										now: at(20_000),
										outcome: "finished",
										patchFiles: 0,
									}),
									false,
								),
							],
			events: (now) => (now - T0 < 20_000 ? [] : [report("e1")]),
		});
		expect(await run()).toBe("ready");
		expect(explore).toHaveBeenCalledWith(expect.anything(), {
			requestKey: "u1",
			requestText: "Add --json.",
		});
		// The report reached the lead's mailbox before the model call.
		expect(deps.stage).toHaveBeenCalledWith(
			"lead",
			"e1",
			expect.stringContaining("Files: a.ts"),
		);
		expect(deps.sleep).toHaveBeenCalled();
	});

	it("ends the step with wait while the round still runs at the step's deadline", async () => {
		const state = newSidekickState({ tokens: 1_000_000 }, at(0), {
			requestKey: "u1",
			kind: "explore",
		});
		const { deps, run, now } = gate({
			children: () => [sidekick(state, true)],
			waitMs: 10_000,
		});
		expect(await run()).toBe("wait");
		expect(now()).toBe(T0 + 10_000);
		expect(deps.explore).not.toHaveBeenCalled();
		expect(deps.stage).not.toHaveBeenCalled();
	});

	it("explores each new request once, never a wake-up, and not when the pair does not explore", async () => {
		const explored = newSidekickState({ tokens: 1_000_000 }, at(-50_000), {
			requestKey: "u1",
			kind: "explore",
		});
		const done = endSidekickRound(explored, {
			now: at(-40_000),
			outcome: "finished",
			patchFiles: 0,
		});
		// Explored already, its report delivered: ready at once.
		const again = gate({
			children: () => [sidekick(done, false)],
			events: () => [{ ...report("e0"), pending: false }],
		});
		expect(await again.run()).toBe("ready");
		expect(again.deps.explore).not.toHaveBeenCalled();
		// A child report waking the lead is no new request.
		const wake = gate({
			children: () => [sidekick(done, false)],
			events: () => [{ ...report("e0"), pending: false }],
			items: [
				...request,
				{
					kind: "userMessage",
					id: SessionItemId("c1"),
					text: "⁣ytimesy-child-event:abc\n[agent 1 writer finished]",
				},
			],
		});
		expect(await wake.run()).toBe("ready");
		expect(wake.deps.explore).not.toHaveBeenCalled();
		// The user's next message: a new exploration round.
		const next = gate({
			children: () => [sidekick(done, false)],
			events: () => [{ ...report("e0"), pending: false }],
			items: [
				...request,
				{ kind: "userMessage", id: SessionItemId("u2"), text: "Also --yaml." },
			],
			explore: vi.fn(async () => null),
		});
		expect(await next.run()).toBe("ready");
		expect(next.deps.explore).toHaveBeenCalledWith(expect.anything(), {
			requestKey: "u2",
			requestText: "Also --yaml.",
		});
		const off = gate({ children: () => [], exploreFlag: false });
		expect(await off.run()).toBe("ready");
		expect(off.deps.explore).not.toHaveBeenCalled();
	});

	it("waits for a build round the lead started and stages its report", async () => {
		const explored = endSidekickRound(
			newSidekickState({ tokens: 1_000_000 }, at(-60_000), {
				requestKey: "u1",
				kind: "explore",
			}),
			{ now: at(-50_000), outcome: "finished", patchFiles: 0 },
		);
		const building = beginSidekickRound(explored, {
			now: at(-1_000),
			steps: 10,
			tokens: 1000,
			requestKey: "u1",
		});
		const { deps, run } = gate({
			children: (now) =>
				now - T0 < 9_000
					? [sidekick(building, true)]
					: [
							sidekick(
								endSidekickRound(building, {
									now: at(9_000),
									outcome: "finished",
									patchFiles: 1,
								}),
								false,
							),
						],
			// The report event lags the round's end by a few seconds.
			events: (now) => (now - T0 < 15_000 ? [] : [report("e2")]),
		});
		expect(await run()).toBe("ready");
		expect(deps.stage).toHaveBeenCalledWith("lead", "e2", expect.any(String));
		expect(deps.reportEvents).toHaveBeenCalledWith("s", at(-1_000));
		expect(
			await fusionRoundOpen(lead, {
				children: async () => [sidekick(building, true)],
			}),
		).toBe(true);
	});

	it("gives up on a round whose sidekick never ran, with a notice to the lead", async () => {
		const stalled = newSidekickState({ tokens: 1_000_000 }, at(-6 * 60_000), {
			requestKey: "u1",
			kind: "explore",
		});
		const { deps, run } = gate({ children: () => [sidekick(stalled, false)] });
		expect(await run()).toBe("ready");
		expect(deps.saveState).toHaveBeenCalledWith(
			"s",
			expect.objectContaining({
				rounds: [expect.objectContaining({ outcome: "failed" })],
			}),
		);
		expect(deps.stage).toHaveBeenCalledWith(
			"lead",
			"sidekick-stalled:s:1",
			expect.stringContaining("did not run or report"),
		);
	});
});

describe("the lead's write guard", () => {
	it("refuses edits and commands while its sidekick round runs, never reads", async () => {
		let busy = false;
		const run = vi.fn(async () => "ok");
		const tools = withSidekickWriteGuard(
			{
				edit: { execute: run },
				write: { execute: run },
				bash: { execute: run },
				read: { execute: run },
				agent_send: { execute: run },
			} as unknown as ToolSet,
			() => busy,
		);
		const call = (name: string) => {
			const execute = tools[name]?.execute as
				| ((input: unknown, options: unknown) => unknown)
				| undefined;
			if (!execute) throw new Error(`no tool ${name}`);
			return execute({}, {});
		};
		expect(await call("edit")).toBe("ok");
		busy = true;
		expect(() => call("edit")).toThrow(LEAD_WAITS_NOTICE);
		expect(() => call("write")).toThrow(LEAD_WAITS_NOTICE);
		expect(() => call("bash")).toThrow(LEAD_WAITS_NOTICE);
		expect(await call("read")).toBe("ok");
		expect(await call("agent_send")).toBe("ok");
	});
});
