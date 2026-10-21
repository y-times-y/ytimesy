import { describe, expect, it } from "vitest";
import {
	independentReviewBrief,
	parseReviewVerdict,
	UNTESTED_PASS_NOTE,
} from "./checker-brief";
import {
	CHECKER_WORKER_TOOL,
	checkerWorkerBrief,
	checkerWorkerBudget,
	pairReviewVerdict,
	ranCommandsText,
	testWasRun,
} from "./checker-pair";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

const BRIEF = {
	taskText: "Make compaction keep the newest version of every key.",
	checkout: "/app",
	changedFiles: ["compaction.py"],
	scratch: "/tmp/ytimesy-attempts/turn/review-1",
};
const PROBE = "python3 /tmp/ytimesy-attempts/turn/review-1/tests/t1.py";

const report = (value: Record<string, unknown>) =>
	`[agent 1 checker finished]\n${JSON.stringify(value)}`;

const items = (...commands: string[]): SessionItem[] =>
	commands.map((command, index) => ({
		kind: "commandExecution",
		id: SessionItemId(`c${index}`),
		command,
		cwd: null,
		status: "completed",
		output: "",
		exitCode: 0,
	}));

describe("the checker pair's brief", () => {
	it("adds the judge's section only in pair mode, after the four parts", () => {
		const single = independentReviewBrief(BRIEF);
		expect(single).not.toContain("<checker_pair>");
		expect(single).not.toContain(CHECKER_WORKER_TOOL);
		const pair = independentReviewBrief({ ...BRIEF, pair: true });
		// The single brief, unchanged, with the judge's section before the answer format.
		const [before, after] = single.split("\n\nAnswer with only this JSON:");
		expect(pair.startsWith(before)).toBe(true);
		expect(pair.endsWith(`Answer with only this JSON:${after}`)).toBe(true);
		expect(pair).toContain(`\`${CHECKER_WORKER_TOOL}\``);
		expect(pair).toContain(
			"under /tmp/ytimesy-attempts/turn/review-1/tests and run",
		);
		expect(pair).toContain("`/tmp/ytimesy-attempts/turn/review-1/work`");
		expect(pair).toContain("The verdict is yours alone");
		expect(pair.indexOf("4. Test it yourself.")).toBeLessThan(
			pair.indexOf("<checker_pair>"),
		);
	});

	it("gives a later round the earlier findings as context for a full check", () => {
		const findings = ["Review 1, F1: ordering is wrong"];
		expect(
			independentReviewBrief({ ...BRIEF, previousFindings: findings }),
		).not.toContain("<previous_review>");
		const pair = independentReviewBrief({
			...BRIEF,
			pair: true,
			previousFindings: findings,
		});
		expect(pair).toContain("Review in four parts:");
		expect(pair).toContain(
			"this review is a full, independent check of all four parts from the start",
		);
		expect(pair).toContain("- Review 1, F1: ordering is wrong");
		expect(
			independentReviewBrief({ ...BRIEF, pair: true, previousFindings: [] }),
		).not.toContain("<previous_review>");
	});

	it("frames the judge's brief for the worker, read-only and without a verdict", () => {
		const worker = checkerWorkerBrief("  Run make test in /x/work.  ");
		expect(worker).toContain("You are read-only");
		expect(worker).toContain("You give no verdict");
		expect(worker).toContain(
			"<judge_brief>\nRun make test in /x/work.\n</judge_brief>",
		);
		expect(worker).not.toContain("<request>");
	});
});

describe("a worker's budget", () => {
	it("gets most of the judge's time less its wrap-up, the level's steps and half the tokens", () => {
		expect(
			checkerWorkerBudget({
				level: 2,
				judgeRemaining: { steps: 58, minutes: 9.5, tokens: 780_000 },
				judgeWrapUpMinutes: 2,
			}),
		).toEqual({ steps: 75, minutes: 7.5, tokens: 390_000 });
		// Capped at the level's limits.
		expect(
			checkerWorkerBudget({
				level: 3,
				judgeRemaining: { steps: 60, minutes: 30, tokens: 5_000_000 },
				judgeWrapUpMinutes: 2,
			}),
		).toEqual({ steps: 40, minutes: 8, tokens: 500_000 });
	});

	it("refuses when too little is left or the level cannot exist", () => {
		const remaining = { steps: 10, minutes: 2.5, tokens: 800_000 };
		expect(
			checkerWorkerBudget({
				level: 2,
				judgeRemaining: remaining,
				judgeWrapUpMinutes: 2,
			}),
		).toBeNull();
		expect(
			checkerWorkerBudget({
				level: 4,
				judgeRemaining: { ...remaining, minutes: 10 },
				judgeWrapUpMinutes: 2,
			}),
		).toBeNull();
	});
});

describe("the pair's verdict", () => {
	it("finds a test's command among what a session ran", () => {
		const ran = ranCommandsText([
			...items(`cd /tmp && ${PROBE}`),
			{
				kind: "dynamicToolCall",
				id: SessionItemId("rc"),
				tool: "run_code",
				input: JSON.stringify({
					code: 'await tools.bash({ command: "bash /scratch/tests/probe.sh" })',
				}),
				status: "completed",
			},
		]);
		expect(testWasRun({ name: "t1", passed: true, command: PROBE }, ran)).toBe(
			true,
		);
		// A path the command names was run, in another shape (a run_code program).
		expect(
			testWasRun(
				{
					name: "probe",
					passed: true,
					command: "bash '/scratch/tests/probe.sh'",
				},
				ran,
			),
		).toBe(true);
		expect(
			testWasRun({ name: "other", passed: true, command: "make check" }, ran),
		).toBe(false);
		expect(testWasRun({ name: "none", passed: true }, ran)).toBe(false);
	});

	it("marks who ran each test and keeps the judge's verdict", () => {
		const verdict = pairReviewVerdict(
			parseReviewVerdict(
				report({
					verdict: "fail",
					failures: ["ordering: wrong"],
					tests: [
						{ name: "t1", command: PROBE, passed: false },
						{
							name: "spot",
							command: "grep -n key /app/compaction.py",
							passed: true,
						},
						{
							name: "claimed",
							command: "pytest /app/tests/never.py",
							passed: true,
						},
					],
				}),
			),
			{
				worker: ranCommandsText(items(PROBE)),
				judge: ranCommandsText(items("grep -n key /app/compaction.py")),
			},
		);
		expect(verdict.verdict).toBe("fail");
		expect(verdict.failures).toEqual(["ordering: wrong"]);
		expect(verdict.tests.map((test) => test.ranBy)).toEqual([
			"worker",
			"judge",
			undefined,
		]);
	});

	it("counts a pass none of whose tests either session ran as unsure", () => {
		const pass = parseReviewVerdict(
			report({
				verdict: "pass",
				failures: [],
				tests: [{ name: "claimed", command: "pytest /app/t.py", passed: true }],
				notes: "looks fine",
			}),
		);
		const verdict = pairReviewVerdict(pass, {
			worker: ranCommandsText(items("make test")),
			judge: "",
		});
		expect(verdict).toMatchObject({
			verdict: "unsure",
			untested: true,
			notes: `${UNTESTED_PASS_NOTE} looks fine`,
		});
		const ran = pairReviewVerdict(pass, {
			worker: ranCommandsText(items("pytest /app/t.py -q")),
			judge: "",
		});
		expect(ran.verdict).toBe("pass");
		expect(ran.untested).toBeUndefined();
		// A pass with no tests at all was already unsure; the note is not doubled.
		const bare = parseReviewVerdict(
			report({ verdict: "pass", failures: [], tests: [], notes: "ok" }),
		);
		expect(pairReviewVerdict(bare, { worker: "", judge: "" }).notes).toBe(
			`${UNTESTED_PASS_NOTE} ok`,
		);
	});
});
