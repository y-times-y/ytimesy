import { describe, expect, it } from "vitest";
import { type FusionTrace, fusionLead } from "../evals/harbor_v2/children";
import type { HarborModel } from "../evals/harbor_v2/config";
import {
	ChildBudgetUsed,
	childBudgetUsed,
	childStepGuard,
	lastChildText,
} from "../evals/harbor_v2/review";
import { type TimedEvent, trialSessions } from "../evals/harbor_v2/sessions";
import { newSidekickState } from "../src/domain/sidekick";

const model = {
	modelId: "m",
	effort: "low",
	billing: { kind: "api" },
} as unknown as HarborModel;

describe("trialSessions", () => {
	it("keeps the trial's child sessions in memory, by parent and role", () => {
		const store = trialSessions(() => 0);
		const sidekick = store.add({ role: "sidekick", parentId: "t", model });
		const checker = store.add({
			role: "checker",
			parentId: "t",
			model,
			id: "harbor-checker-1",
		});
		const worker = store.add({
			role: "checkerWorker",
			parentId: checker.id,
			model,
		});
		const classifier = store.add({
			role: "classifier",
			parentId: sidekick.id,
			model,
		});
		expect(sidekick.id).toBe("t.1");
		expect(worker.id).toBe("harbor-checker-1.1");
		expect(classifier.id).toBe("t.1.1");
		expect(store.children("t").map((s) => s.id)).toEqual([
			"t.1",
			"harbor-checker-1",
		]);
		expect(store.children(checker.id)).toEqual([worker]);
		expect(store.byRole("classifier")).toEqual([classifier]);
		expect(store.latestReport(sidekick.id)).toBeNull();
		sidekick.reports.push({ outcome: "completed", report: "done" });
		expect(store.latestReport(sidekick.id)?.report).toBe("done");
		expect(() =>
			store.add({
				role: "checker",
				parentId: "t",
				model,
				id: "harbor-checker-1",
			}),
		).toThrow(/already exists/);
	});
});

describe("child budgets", () => {
	const usage = (tokens: number): TimedEvent => ({
		at: "2026-10-21T00:00:00.000Z",
		event: {
			type: "usage",
			usage: { inputTokens: tokens, outputTokens: 0 },
		} as TimedEvent["event"],
	});
	const budget = { steps: 60, minutes: 15, tokens: 1_500_000 };
	const sidekickBudget = {
		...budget,
		sidekick: newSidekickState(budget, new Date(0).toISOString()),
	};

	it("counts a sidekick's tokens per round, against the product's round cap", async () => {
		// Round 1 ended at 1.6M (usage is cumulative within a model run).
		const events = [usage(400_000), usage(1_600_000)];
		const guard = childStepGuard({
			role: "sidekick",
			budget: sidekickBudget,
			startedAt: Date.now(),
			events,
			from: events.length,
		});
		// Round 2's first step: round 1's tokens are not this round's.
		expect(await guard([])).toEqual([]);
		events.push(usage(760_000));
		// At the cap: one last step to write the report, then the stop.
		const [last] = await guard([]);
		expect(last.content).toMatch(
			/^Budget used \(this round, tokens 760,000\/750,000\)\. Call no more tools: reply now with your report/,
		);
		const error = await guard([]).catch((caught) => caught);
		expect(error).toBeInstanceOf(ChildBudgetUsed);
		expect(childBudgetUsed(error)?.message).toBe(
			"Sidekick budget used (this round, tokens 760,000/750,000).",
		);
	});

	it("weighs a cheaper child's tokens as the product does, and names the role", async () => {
		const events = [usage(1_000_000)];
		const sidekick = childStepGuard({
			role: "sidekick",
			budget: sidekickBudget,
			startedAt: Date.now(),
			events,
			from: 0,
			weight: 0.25,
		});
		expect(await sidekick([])).toEqual([]);
		const checker = childStepGuard({
			role: "checker",
			budget,
			startedAt: Date.now(),
			events: [usage(1_500_000)],
			from: 0,
		});
		await checker([]);
		await expect(checker([])).rejects.toThrow(
			"Checker budget used (tokens 1,500,000/1,500,000).",
		);
	});

	it("counts cache reads at their price share, so a long cached round fits", async () => {
		// 30 steps of a ~30k-token history: 900k input, 800k of it cache reads.
		const events: TimedEvent[] = [
			{
				at: "2026-10-21T00:00:00.000Z",
				event: {
					type: "usage",
					usage: {
						inputTokens: 900_000,
						cacheReadTokens: 800_000,
						outputTokens: 20_000,
					},
				} as TimedEvent["event"],
			},
		];
		const guard = childStepGuard({
			role: "sidekick",
			budget: sidekickBudget,
			startedAt: Date.now(),
			events,
			from: 0,
		});
		// 100k uncached + 80k (reads at 10%) + 20k output = 200k of 750k.
		expect(await guard([])).toEqual([]);
	});

	it("passes a stopped round's last message to its parent", () => {
		const text = (id: string, value: string): TimedEvent => ({
			at: "2026-10-21T00:00:00.000Z",
			event: { type: "text-delta", id, text: value },
		});
		const events = [
			text("a", "earlier round"),
			usage(10),
			text("b", "Fixed parser.py; "),
			text("b", "tests not run yet."),
			usage(20),
		];
		expect(lastChildText(events, 1)).toBe(
			"Fixed parser.py; tests not run yet.",
		);
		expect(lastChildText(events, 5)).toBe("");
	});

	it("tells the sidekick to wrap up as a writer, not with a checker's JSON", async () => {
		const guard = childStepGuard({
			role: "sidekick",
			budget: sidekickBudget,
			startedAt: Date.now(),
			events: [usage(700_000)],
			from: 0,
		});
		const [notice] = await guard([]);
		expect(notice.content).toContain("Budget nearly used (this round, ");
		expect(notice.content).toContain("write your report");
	});

	it("shows the lead a round stopped at its budget as sidekick budget used", async () => {
		const store = trialSessions(() => 0);
		const trace: FusionTrace = { decisions: [], rounds: [], refused: [] };
		const lead = fusionLead({
			parentId: "t",
			sessions: store,
			model: () => model,
			escalation: null,
			runRound: async () => ({
				outcome: "failed",
				report: "",
				budgetUsed: "this round, tokens 760,000/750,000",
			}),
			callOnce: async () => ({ text: "", usage: null }),
			changedFiles: async () => [" M app.py"],
			trace,
		});
		const text = await lead.explore("Fix the bug.");
		expect(text).toMatch(
			/^Sidekick t\.1 round 1 \(explore\) stopped: sidekick budget used \(this round, tokens 760,000\/750,000\)\./,
		);
		expect(text).not.toMatch(/failed/);
		expect(trace.rounds[0].outcome).toBe("budget exhausted");
		expect(text).toContain("it wrote no report.");
	});

	it("hands the lead a stopped round's last message", async () => {
		const lead = fusionLead({
			parentId: "t",
			sessions: trialSessions(() => 0),
			model: () => model,
			escalation: null,
			runRound: async () => ({
				outcome: "failed",
				report: "Fixed parser.py; tests not run yet.",
				budgetUsed: "this round, tokens 760,000/750,000",
			}),
			callOnce: async () => ({ text: "", usage: null }),
			changedFiles: async () => [],
			trace: { decisions: [], rounds: [], refused: [] },
		});
		const text = await lead.explore("Fix the bug.");
		expect(text).toContain(
			"Its edits so far are in your checkout; its last message:\n\nFixed parser.py; tests not run yet.",
		);
	});
});
