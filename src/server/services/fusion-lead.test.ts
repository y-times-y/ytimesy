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
	LEAD_WAITS_NOTICE,
	leadWriteTracker,
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
	activeTurn?: boolean;
	staged?: boolean;
	thin?: boolean;
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
		activeTurn: vi.fn(async () => options.activeTurn ?? false),
		stop: vi.fn(async () => {}),
		staged: vi.fn(async () => options.staged ?? false),
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
			thin: options.thin,
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

	it("releases Main during a build round: busy at once, no wait, its report left for delivery after Main's turn", async () => {
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
		const running = gate({ children: () => [sidekick(building, true)] });
		expect(await running.run()).toBe("busy");
		expect(running.deps.sleep).not.toHaveBeenCalled();
		expect(running.deps.reportEvents).toHaveBeenCalledWith("s", at(-1_000));
		// Reported: the round is over (Main may write again), and the report is
		// not staged into Main's running turn.
		const reported = gate({
			children: () => [sidekick(building, false)],
			events: () => [report("e2")],
		});
		expect(await reported.run()).toBe("ready");
		expect(reported.deps.stage).not.toHaveBeenCalled();
	});

	it("treats a round as over once its report event exists, though its state still shows it open", async () => {
		// A worker-disconnect recovery (or a failed save) left the state open.
		const open = beginSidekickRound(
			endSidekickRound(
				newSidekickState({ tokens: 1_000_000 }, at(-60_000), {
					requestKey: "u1",
					kind: "explore",
				}),
				{ now: at(-50_000), outcome: "finished", patchFiles: 0 },
			),
			{ now: at(-10_000), steps: 1, tokens: 1, requestKey: "u1" },
		);
		const { deps, run } = gate({
			children: () => [sidekick(open, false)],
			events: () => [{ ...report("e3"), eventType: "failed" as const }],
		});
		expect(await run()).toBe("ready");
		expect(deps.sleep).not.toHaveBeenCalled();
		// A build round's report reaches Main after its turn, not mid-turn.
		expect(deps.stage).not.toHaveBeenCalled();
		// The state is closed to match.
		expect(deps.saveState).toHaveBeenCalledWith(
			"s",
			expect.objectContaining({
				rounds: expect.arrayContaining([
					expect.objectContaining({ n: 2, outcome: "failed", endedAt: at(0) }),
				]),
			}),
		);
	});

	it("gives up on a round whose sidekick never ran, with a notice to the lead", async () => {
		const stalled = newSidekickState({ tokens: 1_000_000 }, at(-6 * 60_000), {
			requestKey: "u1",
			kind: "explore",
		});
		// A queued turn is a round about to run: still waited on.
		const queued = gate({
			children: () => [sidekick(stalled, false)],
			activeTurn: true,
			waitMs: 5_000,
		});
		expect(await queued.run()).toBe("wait");
		expect(queued.deps.saveState).not.toHaveBeenCalled();
		const { deps, run } = gate({ children: () => [sidekick(stalled, false)] });
		expect(await run()).toBe("ready");
		// Retired (its queued round message is dropped) and stopped at once.
		expect(deps.saveState).toHaveBeenCalledWith(
			"s",
			expect.objectContaining({
				rounds: [expect.objectContaining({ outcome: "failed" })],
				retired: expect.objectContaining({
					reason: "round 1 did not run or report",
				}),
			}),
		);
		expect(deps.stop).toHaveBeenCalledWith("s", { now: true });
		expect(deps.stage).toHaveBeenCalledWith(
			"lead",
			"sidekick-stalled:s:1",
			expect.stringContaining("did not run or report"),
		);
		expect(deps.stage).toHaveBeenCalledWith(
			"lead",
			"sidekick-stalled:s:1",
			expect.stringContaining("or do it yourself."),
		);
	});

	it("tells a thin lead to restart a stalled writer, not to take over", async () => {
		const stalled = newSidekickState({ tokens: 1_000_000 }, at(-6 * 60_000), {
			requestKey: "u1",
			kind: "explore",
		});
		const { deps, run } = gate({
			children: () => [sidekick(stalled, false)],
			thin: true,
		});
		expect(await run()).toBe("ready");
		const notice = (
			deps.stage.mock.calls as unknown as [string, string, string][]
		).find(([, id]) => id === "sidekick-stalled:s:1")?.[2];
		expect(notice).toContain(
			"Restart it: start a new writer with `agent` role writer",
		);
		expect(notice).toContain("handoff");
		expect(notice).not.toContain("yourself");
	});
});

describe("the harness exploration's start", () => {
	it("is tried once per request: after a failure the lead plans without snippets", async () => {
		const first = gate({
			children: () => [],
			explore: vi.fn(async () => {
				throw new Error("no capacity");
			}),
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await first.run()).toBe("ready");
		warn.mockRestore();
		expect(first.deps.stage).toHaveBeenCalledWith(
			"lead",
			"exploration-failed:lead:u1",
			expect.stringContaining("could not start (no capacity)"),
		);
		// The next step finds the notice and does not try again.
		const next = gate({ children: () => [], staged: true });
		expect(await next.run()).toBe("ready");
		expect(next.deps.explore).not.toHaveBeenCalled();
	});
});

describe("Main's write guard", () => {
	it("refuses edits and commands while its writer's round runs, never reads", async () => {
		let busy = false;
		const run = vi.fn(async () => "ok");
		const tools = withSidekickWriteGuard(
			{
				edit: { execute: run },
				write: { execute: run },
				bash: { execute: run },
				read: { execute: run },
				agent_send: { execute: run },
				write_stdin: { execute: run },
			} as unknown as ToolSet,
			{ busy: () => busy, track: (result) => result },
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
		expect(() => call("write_stdin")).toThrow(LEAD_WAITS_NOTICE);
		expect(await call("read")).toBe("ok");
		expect(await call("agent_send")).toBe("ok");
	});
});

describe("the lead's write tracker", () => {
	it("lets a round start only after the writes already running finish", async () => {
		const writes = leadWriteTracker();
		let finish = () => {};
		const slow = new Promise<string>((resolve) => {
			finish = () => resolve("edited");
		});
		const tools = withSidekickWriteGuard(
			{ edit: { execute: () => slow } } as unknown as ToolSet,
			writes,
		);
		const edit = tools.edit?.execute as unknown as () => Promise<string>;
		const running = edit();
		writes.start();
		let settled = false;
		const waiting = writes.settled().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		// A write after the handoff is refused at once.
		expect(() => edit()).toThrow(LEAD_WAITS_NOTICE);
		finish();
		await waiting;
		expect(settled).toBe(true);
		expect(await running).toBe("edited");
		writes.clear();
		expect(writes.busy()).toBe(false);
	});
});
