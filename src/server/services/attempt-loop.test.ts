import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { AttemptLoopState, AttemptSnapshot } from "#/domain/attempt-loop";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { readerUserSetupCommand } from "#/domain/subagent-reader";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	type AttemptLoopDeps,
	attemptLoopSpend,
	attemptReport,
	baseMessageCount,
	checkerDirectoryCommand,
	createAttemptLoop,
	parseSuiteRun,
	suiteCommand,
} from "./attempt-loop";

const TASK = "Make compaction keep the newest version of every key.";

type Verdict = {
	verdict: string;
	failures?: string[];
	tests?: unknown[];
	testsPath?: string;
};

/**
 * A fake VM and database: `tree` is the working tree's content id; capture
 * names it, restore sets it. Checkers answer from `verdicts` (one per
 * attempt, in order); suites score from `suiteScores[suite][tree]`.
 */
function harness(options: {
	verdicts: (Verdict | null)[];
	suiteScores?: Record<number, Record<string, [number, number]>>;
	judge?: string;
	deadlineAt?: number;
	now?: () => number;
}) {
	let now = 1_000_000;
	let tree = "t-base";
	let state: AttemptLoopState | null = null;
	let checks = 0;
	const reports = new Map<string, string | null>();
	const started: {
		role: string;
		title: string;
		brief: string;
		cap: unknown;
	}[] = [];
	const vm: string[] = [];
	const routed: string[] = [];
	const restored: string[] = [];
	const snapshots = new Map<string, AttemptSnapshot>();
	const deps: AttemptLoopDeps = {
		now: options.now ?? (() => now),
		sleep: async (ms) => {
			now += ms;
		},
		load: async () => state,
		save: async (_session, next) => {
			state = structuredClone(next);
		},
		runnerDeadline: async () => options.deadlineAt ?? null,
		capture: async (workspace, ref) => {
			const snapshot = {
				cwd: workspace.cwd,
				tree,
				indexTree: `${tree}-index`,
				head: "h0",
				ref,
			};
			snapshots.set(ref, snapshot);
			return snapshot;
		},
		startSubagent: async (input) => {
			started.push(input);
			const id = `child-${started.length}`;
			if (input.role === "reviewer") reports.set(id, options.judge ?? null);
			else {
				const verdict = options.verdicts[checks++];
				reports.set(
					id,
					verdict === null
						? null
						: `[agent 1 checker finished]\n${JSON.stringify({ testsPath: `/tmp/ytimesy-attempts/turn/${checks}/tests`, ...verdict })}`,
				);
			}
			return { sessionId: id };
		},
		takeReport: async (_parent, child) => {
			const report = reports.get(child);
			if (report === null || report === undefined) return null;
			reports.delete(child);
			return { outcome: "completed", report };
		},
		childItems: async () => [
			{
				kind: "userMessage",
				id: "u",
				text: "brief",
				apiUsage: {
					inputTokens: 1000,
					outputTokens: 100,
					uncachedInputTokens: 1000,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
			},
		],
		stopChild: vi.fn(async () => {}),
		vm: async (command) => {
			vm.push(command);
			if (command.includes("symbolic-ref -q HEAD"))
				return { exitCode: 0, stdout: "refs/heads/main\n" };
			if (command.startsWith("python3 -c") && command.includes("restored")) {
				const ref = [...snapshots.keys()].find((key) =>
					command.includes(`'${key}'`),
				);
				const snapshot = ref ? snapshots.get(ref) : undefined;
				if (!snapshot) return { exitCode: 1, stdout: "", stderr: "no ref" };
				tree = snapshot.tree;
				restored.push(snapshot.ref);
				return { exitCode: 0, stdout: "restored\n" };
			}
			if (command.includes("diff --name-only"))
				return { exitCode: 0, stdout: "compaction.py\n" };
			return { exitCode: 0, stdout: "" };
		},
		routed: async (command) => {
			routed.push(command);
			if (command.endsWith(" list"))
				return { exitCode: 0, stdout: "[1, 22]\n" };
			if (/ stop '\[[\d,]*\]'$/.test(command))
				return { exitCode: 0, stdout: '["node on port 3000"]\n' };
			const suite = /ytimesy-attempts\/turn\/(\d+)\/tests/.exec(command);
			if (suite) {
				const [passed, failed] = options.suiteScores?.[Number(suite[1])]?.[
					tree
				] ?? [0, 0];
				return {
					exitCode: 0,
					stdout: `${"PASS x\n".repeat(passed)}${"FAIL y: no\n".repeat(failed)}__SUITE_EXIT=${failed ? 1 : 0}\n`,
				};
			}
			return { exitCode: 0, stdout: "" };
		},
		stopOwnedCommands: vi.fn(async () => {}),
	};
	const workspace: AgentToolWorkspace = {
		machines: {} as AgentToolWorkspace["machines"],
		vm: WorkspaceId("vm"),
		cwd: "/home/ubuntu/app",
	};
	const loop = createAttemptLoop({
		sessionId: "session",
		turnId: "turn",
		max: 3,
		workspace: async () => workspace,
		signal: new AbortController().signal,
		billing: { kind: "plan", price: { input: 2, output: 10, cacheRead: 0.25 } },
		taskText: () => TASK,
		isRequest: (message) => message.role === "user" && message.content === TASK,
		deps,
	});
	const request: ModelMessage = { role: "user", content: TASK };
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
	const step = (usage: number, text: string, extra: ModelMessage[] = []) => ({
		messages: [
			request,
			{ role: "user", content: "AGENTS.md: run pytest" },
			{ role: "assistant", content: "working" },
			...extra,
		] as ModelMessage[],
		items: items(usage, text),
		waitUntil: now + 600_000,
	});
	return {
		loop,
		deps,
		started,
		vm,
		routed,
		restored,
		state: () => state as AttemptLoopState | null,
		setTree: (next: string) => {
			tree = next;
		},
		tree: () => tree,
		advance: (ms: number) => {
			now += ms;
		},
		step,
		reports,
	};
}

describe("the attempt loop", () => {
	it("checkpoints before the first model step", async () => {
		const h = harness({ verdicts: [] });
		expect(await h.loop.beforeModel(h.step(0, ""))).toEqual({ kind: "run" });
		const state = h.state();
		expect(state).toMatchObject({
			phase: "attempting",
			attempt: 1,
			max: 3,
			listenersAtStart: [1, 22],
			checkpoint: { tree: "t-base", ref: "refs/ytimesy/attempts/turn-base" },
		});
		expect(state?.deadlineAt).toBe(1_000_000 + 90 * 60_000);
		// A later step does not checkpoint again.
		expect(await h.loop.beforeModel(h.step(0, ""))).toEqual({ kind: "run" });
		expect(h.state()?.checkpoint.ref).toBe("refs/ytimesy/attempts/turn-base");
	});

	it("finishes when the first attempt passes its independent check", async () => {
		const h = harness({ verdicts: [{ verdict: "pass", tests: [] }] });
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t1");
		h.advance(60_000);
		const outcome = await h.loop.afterAttempt(h.step(5000, "Done: fixed it."));
		expect(outcome.kind).toBe("finished");
		expect(h.restored).toEqual([]);
		const state = h.state() as AttemptLoopState;
		expect(state).toMatchObject({ phase: "done", kept: 1 });
		expect(state.candidates[0]).toMatchObject({
			n: 1,
			report: "Done: fixed it.",
			verdict: { verdict: "pass" },
			snapshot: { tree: "t1", ref: "refs/ytimesy/attempts/turn-1" },
		});
		// The checker's brief: the request verbatim and the change, never the report.
		expect(h.started).toHaveLength(1);
		expect(h.started[0].role).toBe("checker");
		expect(h.started[0].brief).toContain(`<request>\n${TASK}\n</request>`);
		expect(h.started[0].brief).toContain(
			"files changed by the run: compaction.py.",
		);
		expect(h.started[0].brief).not.toContain("Done: fixed it.");
		expect(h.vm.some((command) => command.includes("ytimesy-reader"))).toBe(
			true,
		);
		// The summary card; no extra answer since the kept attempt answered last.
		if (outcome.kind === "finished") {
			expect(outcome.items.at(-1)).toMatchObject({
				kind: "dynamicToolCall",
				tool: "attempt_check",
			});
			expect(
				outcome.items.some((item) => item.id === "attempt-loop:turn:kept"),
			).toBe(false);
		}
	});

	it("resets and starts a different approach after a failed check", async () => {
		const h = harness({
			verdicts: [
				{ verdict: "fail", failures: ["ordering: newest version hidden"] },
				{ verdict: "pass" },
			],
		});
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t1");
		const first = await h.loop.afterAttempt(
			h.step(5000, "Fixed the visibility bug.", [
				{ role: "assistant", content: "more work" },
			]),
		);
		expect(first.kind).toBe("run");
		// Back at the checkpoint, the attempt's listeners stopped.
		expect(h.tree()).toBe("t-base");
		expect(h.restored).toEqual(["refs/ytimesy/attempts/turn-base"]);
		expect(h.routed.some((command) => command.endsWith(" stop '[1,22]'"))).toBe(
			true,
		);
		if (first.kind === "run") {
			const messages = first.messages as ModelMessage[];
			// The request and its turn-start context, then the notice: not the failed trail.
			expect(messages).toHaveLength(3);
			expect(messages[0]).toEqual({ role: "user", content: TASK });
			expect(messages[1].content).toBe("AGENTS.md: run pytest");
			const notice = String(messages[2].content);
			expect(notice).toContain("Attempt 1 of 3 failed an independent check");
			expect(notice).toContain("ordering: newest version hidden");
			expect(notice).toContain("Fixed the visibility bug.");
			expect(notice).toContain("node on port 3000");
			expect(notice).toContain("This is attempt 2. Take a different approach");
		}
		expect(h.state()).toMatchObject({ phase: "attempting", attempt: 2 });
		expect(await h.loop.beforeModel(h.step(5000, ""))).toEqual({ kind: "run" });
		h.setTree("t2");
		const second = await h.loop.afterAttempt(
			h.step(9000, "Rewrote the merge."),
		);
		expect(second.kind).toBe("finished");
		const state = h.state() as AttemptLoopState;
		expect(state.kept).toBe(2);
		// Per-attempt spend: the builder's share since the attempt began.
		expect(state.candidates[0].builderUsage?.inputTokens).toBe(5000);
		expect(state.candidates[1].builderUsage?.inputTokens).toBe(4000);
		const spend = attemptLoopSpend(state, {
			kind: "plan",
			price: { input: 2, output: 10 },
		});
		expect(spend.attempts[0].checker.tokens).toBe(1100);
		expect(spend.total.tokens).toBe(5500 + 4400 + 2 * 1100);
		expect(spend.total.estimated).toBe(true);
	});

	it("keeps the best of three by cross-checking every suite against every candidate", async () => {
		const h = harness({
			verdicts: [
				{ verdict: "fail", failures: ["a"] },
				{ verdict: "fail", failures: ["b"] },
				{ verdict: "unsure" },
			],
			suiteScores: {
				1: { t1: [1, 3], t2: [4, 0], t3: [2, 2] },
				2: { t1: [2, 2], t2: [3, 1], t3: [1, 3] },
				3: { t1: [1, 1], t2: [2, 0], t3: [2, 0] },
			},
		});
		await h.loop.beforeModel(h.step(0, ""));
		for (const [index, tree] of ["t1", "t2", "t3"].entries()) {
			h.setTree(tree);
			const outcome = await h.loop.afterAttempt(
				h.step(1000 * (index + 1), `Report ${index + 1}`),
			);
			if (index < 2) {
				expect(outcome.kind).toBe("run");
				await h.loop.beforeModel(h.step(1000 * (index + 1), ""));
			} else {
				expect(outcome.kind).toBe("finished");
				if (outcome.kind === "finished") {
					const kept = outcome.items.find(
						(item) => item.id === "attempt-loop:turn:kept",
					);
					expect(kept).toMatchObject({ kind: "agentMessage" });
					expect(kept?.kind === "agentMessage" && kept.text).toContain(
						"Kept attempt 2 of 3",
					);
					expect(kept?.kind === "agentMessage" && kept.text).toContain(
						"Report 2",
					);
					expect(outcome.messages.at(-1)?.role).toBe("assistant");
				}
			}
		}
		const state = h.state() as AttemptLoopState;
		expect(state.kept).toBe(2);
		expect(state.selection?.reason).toBe("attempts");
		expect(state.selection?.runs).toHaveLength(9);
		expect(h.tree()).toBe("t2");
		expect(h.started.filter((spec) => spec.role === "reviewer")).toHaveLength(
			0,
		);
	});

	it("runs a suite only from the attempt's own directory", async () => {
		const h = harness({
			verdicts: [
				{ verdict: "fail", failures: ["a"], testsPath: "/home/ubuntu/.ssh" },
				{ verdict: "fail", failures: ["b"] },
				{ verdict: "fail", failures: ["c"] },
			],
		});
		await h.loop.beforeModel(h.step(0, ""));
		for (const tree of ["t1", "t2", "t3"]) {
			h.setTree(tree);
			await h.loop.afterAttempt(h.step(1000, tree));
			if (tree !== "t3") await h.loop.beforeModel(h.step(1000, ""));
		}
		const suites = h.routed.filter((command) => command.includes("run.sh"));
		expect(suites.length).toBeGreaterThan(0);
		expect(suites.some((command) => command.includes(".ssh"))).toBe(false);
		expect(
			suites.some((command) =>
				command.includes("/tmp/ytimesy-attempts/turn/1/tests/run.sh"),
			),
		).toBe(true);
	});

	it("waits across steps for a checker that has not reported", async () => {
		const h = harness({ verdicts: [null] });
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t1");
		const step = { ...h.step(1000, "done"), waitUntil: 0 };
		expect(await h.loop.afterAttempt(step)).toEqual({ kind: "wait" });
		expect(h.state()?.phase).toBe("checking");
		expect(await h.loop.beforeModel({ ...step, waitUntil: 0 })).toEqual({
			kind: "wait",
		});
		h.reports.set("child-1", JSON.stringify({ verdict: "pass" }));
		const outcome = await h.loop.beforeModel(h.step(1000, "done"));
		expect(outcome.kind).toBe("finished");
		expect(h.state()?.kept).toBe(1);
	});

	it("cuts off an attempt at the deadline and keeps the better checked candidate", async () => {
		const h = harness({
			verdicts: [
				{
					verdict: "fail",
					failures: ["x"],
					tests: [
						{ name: "a", passed: true },
						{ name: "b", passed: false },
					],
				},
			],
			deadlineAt: 1_000_000 + 10 * 60_000,
			suiteScores: { 1: { t1: [1, 1], t2: [0, 2] } },
		});
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t1");
		await h.loop.afterAttempt(h.step(1000, "first"));
		h.setTree("t2");
		h.advance(9 * 60_000);
		const outcome = await h.loop.beforeModel(h.step(2000, ""));
		expect(outcome.kind).toBe("finished");
		expect(h.deps.stopOwnedCommands).toHaveBeenCalled();
		const state = h.state() as AttemptLoopState;
		expect(state.candidates[1]).toMatchObject({
			n: 2,
			cutOff: true,
			checker: null,
		});
		expect(state.selection?.reason).toBe("time");
		expect(state.kept).toBe(1);
		expect(h.tree()).toBe("t1");
	});

	it("breaks a tie with a judge", async () => {
		const h = harness({
			verdicts: [
				{ verdict: "fail", failures: ["a"] },
				{ verdict: "fail", failures: ["b"] },
				{ verdict: "fail", failures: ["c"] },
			],
			suiteScores: {
				1: { t1: [1, 1], t2: [1, 1], t3: [1, 1] },
				2: { t1: [1, 1], t2: [1, 1], t3: [1, 1] },
				3: { t1: [1, 1], t2: [1, 1], t3: [1, 1] },
			},
			judge: '{"winner":"B","reason":"handles deletes"}',
		});
		await h.loop.beforeModel(h.step(0, ""));
		for (const tree of ["t1", "t2", "t3"]) {
			h.setTree(tree);
			const outcome = await h.loop.afterAttempt(h.step(1000, tree));
			if (tree !== "t3") await h.loop.beforeModel(h.step(1000, ""));
			else expect(outcome.kind).toBe("finished");
		}
		const judge = h.started.find((spec) => spec.role === "reviewer");
		expect(judge?.brief).toContain(TASK);
		const state = h.state() as AttemptLoopState;
		// Tied: attempt 3 ranks first (later), the judge picked B = attempt 2.
		expect(state.selection?.judge?.winner).toBe(2);
		expect(state.kept).toBe(2);
		expect(h.tree()).toBe("t2");
	});

	it("does not check an attempt that changed nothing", async () => {
		const h = harness({ verdicts: [] });
		await h.loop.beforeModel(h.step(0, ""));
		const outcome = await h.loop.afterAttempt(h.step(100, "It already works."));
		expect(outcome.kind).toBe("finished");
		expect(h.started).toHaveLength(0);
		expect(h.state()).toMatchObject({ phase: "done", kept: 1 });
	});

	it("stops retrying when the time left cannot fit another attempt", async () => {
		const h = harness({
			verdicts: [{ verdict: "fail", failures: ["x"] }],
			deadlineAt: 1_000_000 + 4 * 60_000,
		});
		await h.loop.beforeModel(h.step(0, ""));
		h.setTree("t1");
		h.advance(3 * 60_000);
		const outcome = await h.loop.afterAttempt(h.step(1000, "first"));
		expect(outcome.kind).toBe("finished");
		expect(h.state()?.selection?.reason).toBe("time");
		expect(h.tree()).toBe("t1");
	});
});

describe("helpers", () => {
	it("creates the reader user before handing it the checker's directory", () => {
		// hs30b-rvon: the VM image predated the reader user, so the ownership
		// step failed, and the fallback failed on the root it had just made 0755.
		const command = checkerDirectoryCommand(
			"/tmp/ytimesy-attempts/turn-1/review-1",
		);
		const setup = command.indexOf(readerUserSetupCommand());
		const owned = command.indexOf("-o ytimesy-reader");
		expect(setup).toBeGreaterThanOrEqual(0);
		expect(owned).toBeGreaterThan(setup);
		// The shared root and the turn's directory stay writable for the fallback.
		expect(command).toContain(
			"sudo -n chmod 1777 '/tmp/ytimesy-attempts' '/tmp/ytimesy-attempts/turn-1'",
		);
		expect(command).not.toMatch(/-m 0755 '\/tmp\/ytimesy-attempts'/);
		expect(command).toMatch(
			/\|\| \{ mkdir -p '\/tmp\/ytimesy-attempts\/turn-1\/review-1' && chmod 0777 /,
		);
	});

	it("finds the messages before the first attempt", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "old" },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: "new request" },
			{ role: "user", content: "context" },
			{ role: "assistant", content: "work" },
		];
		expect(
			baseMessageCount(
				messages,
				(m) => m.role === "user" && m.content !== "context",
			),
		).toBe(4);
		expect(baseMessageCount(messages, () => false)).toBeNull();
	});

	it("reads an attempt's final answer since the request", () => {
		expect(
			attemptReport([
				{ kind: "agentMessage", id: SessionItemId("o"), text: "older" },
				{ kind: "userMessage", id: SessionItemId("u"), text: "go" },
				{ kind: "agentMessage", id: SessionItemId("a"), text: "first" },
				{ kind: "agentMessage", id: SessionItemId("b"), text: "final" },
			]),
		).toBe("final");
	});

	it("runs a suite and reads its result", () => {
		const command = suiteCommand("/tmp/ytimesy-attempts/t/1/tests", "/w", 60);
		expect(command).toContain(
			"timeout -k 5 60 bash '/tmp/ytimesy-attempts/t/1/tests/run.sh' '/w'",
		);
		expect(parseSuiteRun("PASS a\nFAIL b\n__SUITE_EXIT=1", 1, 2)).toEqual({
			suite: 1,
			candidate: 2,
			passed: 1,
			failed: 1,
			exitCode: 1,
			timedOut: false,
		});
		expect(parseSuiteRun("__SUITE_MISSING", 1, 2)).toBeNull();
		expect(parseSuiteRun("__SUITE_EXIT=124", 1, 2)?.timedOut).toBe(true);
	});
});

describe("restore against a real repository", () => {
	it("returns the checkout to a snapshot: files, index, HEAD; ignored files stay", async () => {
		const { execFileSync, execSync } = await import("node:child_process");
		const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } =
			await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { captureConversationCode } = await import(
			"./conversation-code-checkpoint"
		);
		const { restoreSnapshotCommand } = await import("./attempt-loop");
		const root = mkdtempSync(join(tmpdir(), "attempt-loop-"));
		try {
			const git = (...args: string[]) =>
				execFileSync("git", ["-C", root, ...args], {
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "t",
						GIT_AUTHOR_EMAIL: "t@t",
						GIT_COMMITTER_NAME: "t",
						GIT_COMMITTER_EMAIL: "t@t",
					},
				})
					.toString()
					.trim();
			git("init", "-q", "-b", "main");
			writeFileSync(join(root, ".gitignore"), "build/\n");
			writeFileSync(join(root, "a.txt"), "a0\n");
			writeFileSync(join(root, "c.txt"), "c0\n");
			git("add", "-A");
			git("commit", "-q", "-m", "init");
			const head = git("rev-parse", "HEAD");
			// The user's uncommitted work belongs to the checkpoint.
			writeFileSync(join(root, "a.txt"), "a-user\n");
			writeFileSync(join(root, "b.txt"), "b-untracked\n");
			const exec = async (_vm: unknown, command: string) => {
				try {
					return {
						exitCode: 0,
						stdout: execSync(command, { shell: "/bin/bash" }).toString(),
						stderr: "",
					};
				} catch (error) {
					const failure = error as { status?: number; stderr?: Buffer };
					return {
						exitCode: failure.status ?? 1,
						stdout: "",
						stderr: failure.stderr?.toString() ?? "",
					};
				}
			};
			const workspace = {
				machines: { exec } as unknown as AgentToolWorkspace["machines"],
				vm: WorkspaceId("local"),
				cwd: root,
			};
			const checkpoint = await captureConversationCode(
				workspace,
				"refs/ytimesy/attempts/t-base",
			);
			// The attempt: edits, deletes, adds, commits, builds.
			writeFileSync(join(root, "a.txt"), "a-attempt\n");
			rmSync(join(root, "c.txt"));
			writeFileSync(join(root, "d.txt"), "d-new\n");
			git("add", "-A");
			git("commit", "-q", "-m", "attempt");
			writeFileSync(join(root, "e.txt"), "e-untracked\n");
			execSync(`mkdir -p ${root}/build && echo out > ${root}/build/x`);
			const candidate = await captureConversationCode(
				workspace,
				"refs/ytimesy/attempts/t-1",
			);
			const reset = await exec(
				null,
				restoreSnapshotCommand(checkpoint, "refs/heads/main"),
			);
			expect(reset.stdout).toContain("restored");
			expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a-user\n");
			expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b-untracked\n");
			expect(readFileSync(join(root, "c.txt"), "utf8")).toBe("c0\n");
			expect(existsSync(join(root, "d.txt"))).toBe(false);
			expect(existsSync(join(root, "e.txt"))).toBe(false);
			expect(existsSync(join(root, "build/x"))).toBe(true);
			expect(git("rev-parse", "HEAD")).toBe(head);
			expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
			// b.txt was untracked at the checkpoint and is untracked again.
			// (the helper trims the leading space of " M")
			expect(git("status", "--porcelain")).toBe("M a.txt\n?? b.txt");
			// And forward to the candidate (its commit included).
			await exec(null, restoreSnapshotCommand(candidate, "refs/heads/main"));
			expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a-attempt\n");
			expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("e-untracked\n");
			expect(existsSync(join(root, "c.txt"))).toBe(false);
			expect(git("log", "-1", "--format=%s")).toBe("attempt");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("listener scripts", () => {
	it("run under python3 and answer JSON even without /proc", async () => {
		const { execSync } = await import("node:child_process");
		const { listenersCommand } = await import("./attempt-loop");
		const listed = JSON.parse(
			execSync(listenersCommand(), { shell: "/bin/bash" }).toString(),
		);
		expect(Array.isArray(listed)).toBe(true);
		// Stopping is exercised only where it cannot signal real servers (no /proc).
		if (process.platform === "linux") return;
		const stopped = JSON.parse(
			execSync(listenersCommand(listed), { shell: "/bin/bash" }).toString(),
		);
		expect(stopped).toEqual([]);
	});
});
