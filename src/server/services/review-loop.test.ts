import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { AttemptSnapshot } from "#/domain/attempt-loop";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import type { ReviewLoopState } from "#/domain/review-loop";
import type { SessionItem } from "#/domain/session-item";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	createReviewLoop,
	type ReviewLoopDeps,
	reviewLoopSpend,
} from "./review-loop";

const TASK = "Make compaction keep the newest version of every key.";

/**
 * A fake VM and database: `tree` is the working tree's content id; capture
 * names it. Checkers answer from `reports` (one per check, in order; null =
 * never answers).
 */
function harness(options: {
	reports: (string | null)[];
	deadlineAt?: number;
	changed?: string;
}) {
	let now = 1_000_000;
	let tree = "t-base";
	let state: ReviewLoopState | null = null;
	let checks = 0;
	const pending = new Map<string, string | null>();
	const started: {
		role: string;
		title: string;
		brief: string;
		cap: unknown;
	}[] = [];
	const vm: string[] = [];
	const deps: ReviewLoopDeps = {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		load: async () => state,
		save: async (_session, next) => {
			state = structuredClone(next);
		},
		runnerDeadline: async () => options.deadlineAt ?? null,
		capture: async (workspace, ref): Promise<AttemptSnapshot> => ({
			cwd: workspace.cwd,
			tree,
			indexTree: `${tree}-index`,
			head: "h0",
			ref,
		}),
		startSubagent: async (input) => {
			started.push(input);
			const id = `child-${started.length}`;
			pending.set(id, options.reports[checks++] ?? null);
			return { sessionId: id };
		},
		takeReport: async (_parent, child) => {
			const report = pending.get(child);
			if (report === null || report === undefined) return null;
			pending.delete(child);
			return { outcome: "completed", report };
		},
		childItems: async () => [
			{
				kind: "userMessage",
				id: "u",
				text: "brief",
				apiUsage: {
					inputTokens: 2000,
					outputTokens: 200,
					uncachedInputTokens: 2000,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
			},
		],
		stopChild: vi.fn(async () => {}),
		vm: async (command) => {
			vm.push(command);
			if (command.includes("diff --name-only"))
				return { exitCode: 0, stdout: options.changed ?? "compaction.py\n" };
			return { exitCode: 0, stdout: "" };
		},
	};
	const workspace: AgentToolWorkspace = {
		machines: {} as AgentToolWorkspace["machines"],
		vm: WorkspaceId("vm"),
		cwd: "/home/ubuntu/app",
	};
	const loop = createReviewLoop({
		sessionId: "session",
		turnId: "turn",
		workspace: async () => workspace,
		signal: new AbortController().signal,
		billing: { kind: "plan", price: { input: 2, output: 10, cacheRead: 0.25 } },
		taskText: () => TASK,
		deps,
	});
	const items = (usage: number, text: string): SessionItem[] => [
		{
			kind: "userMessage",
			id: SessionItemId("request"),
			text: TASK,
			apiUsage: {
				inputTokens: usage,
				outputTokens: usage / 10,
				uncachedInputTokens: usage,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		},
		{ kind: "agentMessage", id: SessionItemId(`a-${text}`), text },
	];
	const messages: ModelMessage[] = [
		{ role: "user", content: TASK },
		{ role: "assistant", content: "working" },
	];
	const step = (usage: number, text: string, extra: ModelMessage[] = []) => ({
		messages: [...messages, ...extra],
		items: items(usage, text),
		waitUntil: now + 600_000,
	});
	return {
		loop,
		deps,
		started,
		vm,
		state: () => state as ReviewLoopState | null,
		setTree: (next: string) => {
			tree = next;
		},
		advance: (ms: number) => {
			now += ms;
		},
		step,
		now: () => now,
	};
}

const verdict = (value: Record<string, unknown>) =>
	`[agent 1 checker finished]\n${JSON.stringify(value)}`;

const FAIL = verdict({
	verdict: "fail",
	failures: ["ordering: a newer tombstone hides an older live version"],
	requirements: [
		{ requirement: "regression test", met: true, evidence: "make test ok" },
		{
			requirement: "compaction keeps obsolete versions bounded",
			met: false,
			evidence: "versions grow 3x after 1000 writes",
		},
	],
	assumptions: [
		{
			assumption: "snapshot = sequence",
			alternative: "wall time",
			outcome: "seq",
		},
	],
});

describe("review loop", () => {
	it("checks the finished turn, hands concrete findings back to the same run, and finishes on pass", async () => {
		const h = harness({
			reports: [FAIL, verdict({ verdict: "pass", failures: [] })],
		});
		expect((await h.loop.beforeModel(h.step(0, ""))).kind).toBe("run");
		expect(h.state()?.checkpoint.ref).toBe("refs/ytimesy/review/turn-base");
		h.setTree("t-1");
		h.advance(4 * 60_000);
		const first = await h.loop.afterAttempt(h.step(10_000, "Done."));
		// The checker got the shared brief: request verbatim, files, diff command.
		expect(h.started[0].role).toBe("checker");
		expect(h.started[0].brief).toContain(`<request>\n${TASK}\n</request>`);
		expect(h.started[0].brief).toContain(
			"files changed by the run: compaction.py",
		);
		expect(h.started[0].brief).toContain(
			"`git -C /home/ubuntu/app diff refs/ytimesy/review/turn-base refs/ytimesy/review/turn-r1` shows the whole change.",
		);
		expect(h.started[0].brief).not.toContain("Done.");
		expect(
			h.vm.some((command) =>
				command.includes("/tmp/ytimesy-attempts/turn/review-1"),
			),
		).toBe(true);
		expect(first.kind).toBe("run");
		if (first.kind !== "run") throw new Error();
		// Same history plus one notice: nothing reset.
		expect(first.messages?.slice(0, 2)).toEqual(h.step(0, "").messages);
		const notice = String(first.messages?.at(-1)?.content);
		expect(notice).toMatch(
			/^Runtime notice, not a new user request\. An independent checker reviewed your work/,
		);
		expect(notice).toContain(
			"F1. ordering: a newer tombstone hides an older live version",
		);
		expect(notice).toContain(
			"F2. compaction keeps obsolete versions bounded: versions grow 3x after 1000 writes",
		);
		expect(notice).toContain(
			"F3. Assumption: snapshot = sequence; alternative: wall time",
		);
		expect(notice).toContain("`F1: fixed` or `F1: rejected - <why>`");
		expect(notice).not.toContain("regression test");
		expect(h.state()?.phase).toBe("fixing");
		expect(first.items?.at(-1)).toMatchObject({ tool: "review_check" });
		// The fix: the builder answers, the tree changed; a second check passes.
		expect((await h.loop.beforeModel(h.step(10_000, ""))).kind).toBe("run");
		h.setTree("t-2");
		h.advance(60_000);
		const done = await h.loop.afterAttempt(
			h.step(
				14_000,
				"Fixed ordering.\nF1: fixed\nF2: rejected - bounded by design, see compact.py:40\nF3: fixed",
			),
		);
		expect(done.kind).toBe("finished");
		const state = h.state() as ReviewLoopState;
		expect(state.outcome).toBe("pass");
		expect(state.rounds.map((round) => round.verdict?.verdict)).toEqual([
			"fail",
			"pass",
		]);
		expect(state.rounds[0].fix?.responses).toEqual({
			fixed: ["F1", "F3"],
			rejected: [{ id: "F2", reason: "bounded by design, see compact.py:40" }],
			unanswered: [],
		});
		expect(state.rounds[0].fix?.usage?.inputTokens).toBe(4000);
		const spend = reviewLoopSpend(state, {
			kind: "plan",
			price: { input: 2, output: 10, cacheRead: 0.25 },
		});
		expect(spend.checker.tokens).toBe(4400);
		expect(spend.fix.tokens).toBe(4400);
		expect(spend.rounds).toHaveLength(2);
	});

	it("stops after two rounds", async () => {
		const h = harness({ reports: [FAIL, FAIL] });
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t-1");
		h.advance(4 * 60_000);
		expect((await h.loop.afterAttempt(h.step(1, "Done."))).kind).toBe("run");
		h.setTree("t-2");
		expect((await h.loop.afterAttempt(h.step(2, "F1: fixed"))).kind).toBe(
			"run",
		);
		h.setTree("t-3");
		const last = await h.loop.afterAttempt(h.step(3, "F1: fixed"));
		expect(last.kind).toBe("finished");
		expect(h.state()?.outcome).toBe("rounds");
		expect(h.started).toHaveLength(2);
	});

	it("finishes on unsure without concrete findings, and on a fix that changed nothing", async () => {
		const h = harness({
			reports: [
				verdict({ verdict: "unsure", failures: [], notes: "could not run it" }),
			],
		});
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t-1");
		h.advance(4 * 60_000);
		expect((await h.loop.afterAttempt(h.step(1, "Done."))).kind).toBe(
			"finished",
		);
		expect(h.state()?.outcome).toBe("no-findings");

		const g = harness({ reports: [FAIL] });
		await g.loop.beforeModel(g.step(0, ""));
		g.setTree("t-1");
		g.advance(4 * 60_000);
		await g.loop.afterAttempt(g.step(1, "Done."));
		const unchanged = await g.loop.afterAttempt(
			g.step(2, "F1: rejected - wrong"),
		);
		expect(unchanged.kind).toBe("finished");
		expect(g.state()).toMatchObject({
			outcome: "no-findings",
			note: "the fix changed no file",
		});
	});

	it("skips trivial turns and turns without changes", async () => {
		const docs = harness({ reports: [FAIL], changed: "README.md\n" });
		await docs.loop.beforeModel(docs.step(0, ""));
		docs.setTree("t-1");
		docs.advance(30_000);
		expect((await docs.loop.afterAttempt(docs.step(1, "Done."))).kind).toBe(
			"finished",
		);
		expect(docs.state()).toMatchObject({
			outcome: "not-eligible",
			note: "a short turn without a runnable deliverable",
		});
		expect(docs.started).toHaveLength(0);
		// A short turn that delivered code is reviewed.
		const code = harness({ reports: [FAIL], changed: "tool.py\n" });
		await code.loop.beforeModel(code.step(0, ""));
		code.setTree("t-1");
		code.advance(30_000);
		expect((await code.loop.afterAttempt(code.step(1, "Done."))).kind).toBe(
			"run",
		);
		const none = harness({ reports: [FAIL], changed: "" });
		await none.loop.beforeModel(none.step(0, ""));
		none.advance(10 * 60_000);
		await none.loop.afterAttempt(none.step(1, "Answer."));
		expect(none.state()).toMatchObject({
			outcome: "not-eligible",
			note: "no files changed",
		});
	});

	it("respects a runner's deadline: no check without time for a check and a fix", async () => {
		const h = harness({ reports: [FAIL], deadlineAt: 1_000_000 + 5 * 60_000 });
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t-1");
		h.advance(3 * 60_000);
		// 2 minutes left < 150 s expected check + 60 s fix.
		expect((await h.loop.afterAttempt(h.step(1, "Done."))).kind).toBe(
			"finished",
		);
		expect(h.state()?.outcome).toBe("time");
		expect(h.started).toHaveLength(0);

		const tight = harness({
			reports: [FAIL],
			deadlineAt: 1_000_000 + 7 * 60_000,
		});
		await tight.loop.beforeModel(tight.step(0, ""));
		tight.setTree("t-1");
		tight.advance(2 * 60_000);
		await tight.loop.afterAttempt(tight.step(1, "Done."));
		// The check gets what is left but the fix's minute: 4 minutes.
		expect(tight.started[0].cap).toMatchObject({ minutes: 4 });
	});

	it("waits across steps, stops a silent checker after its budget and finishes", async () => {
		const h = harness({ reports: [null] });
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t-1");
		h.advance(4 * 60_000);
		const step = { ...h.step(1, "Done."), waitUntil: h.now() + 30_000 };
		expect((await h.loop.afterAttempt(step)).kind).toBe("wait");
		expect(h.state()?.phase).toBe("checking");
		const resumed = await h.loop.beforeModel({
			...h.step(1, ""),
			waitUntil: h.now() + 60 * 60_000,
		});
		expect(h.deps.stopChild).toHaveBeenCalledWith("child-1");
		expect(resumed.kind).toBe("finished");
		expect(h.state()).toMatchObject({
			outcome: "check-failed",
			note: "the checker gave no verdict in time",
		});
		expect(h.state()?.rounds[0].timedOut).toBe(true);
	});

	it("salvages a verdict cut off at the checker's limit", async () => {
		const cut = FAIL.slice(0, FAIL.indexOf('"assumptions"'));
		const h = harness({ reports: [cut] });
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t-1");
		h.advance(4 * 60_000);
		const next = await h.loop.afterAttempt(h.step(1, "Done."));
		expect(next.kind).toBe("run");
		expect(h.state()?.rounds[0].verdict?.truncated).toBe(true);
	});
});
