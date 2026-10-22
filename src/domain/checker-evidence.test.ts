import { describe, expect, it } from "vitest";
import { parseReviewVerdict } from "./checker-brief";
import {
	commandWasRun,
	executedCommands,
	groundReviewVerdict,
	UNGROUNDED_PASS_NOTE,
} from "./checker-evidence";
import { SessionItemId } from "./ids";
import {
	failingTests,
	type ReviewLoopState,
	retryCheck,
	reviewFindings,
	reviewLoopSummary,
} from "./review-loop";
import type { SessionItem } from "./session-item";

const review = (value: Record<string, unknown>) =>
	parseReviewVerdict(JSON.stringify(value));

const RECOMPUTE = "python3 /tmp/check/tests/recompute.py";
const REPRO = "python3 /tmp/check/tests/repro_get.py";

const FAIL = {
	verdict: "fail",
	failures: [
		{
			failure: "precedence: rule 2 outranks rule 5",
			command: RECOMPUTE,
			output: "expected a.txt, got b.txt",
		},
		"units: the output is in ms, the spec says seconds",
	],
	tests: [
		{ name: "get after delete", command: REPRO, passed: true, output: "ok" },
	],
	requirements: [
		{ requirement: "get returns the newest", met: true, command: REPRO },
		{
			requirement: "writes /app/out.json",
			met: false,
			command: "ls /app/out.json",
			output: "No such file",
		},
	],
};

describe("execution-grounded verdicts", () => {
	it("reads executed commands from shell items, command tools and run_code, never from file writes", () => {
		const items: SessionItem[] = [
			{
				kind: "commandExecution",
				id: SessionItemId("a"),
				command: "make test",
				cwd: null,
				status: "completed",
				output: "",
				exitCode: 0,
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("b"),
				tool: "bash",
				input: JSON.stringify({ command: `${REPRO} --v "x"` }, null, 2),
				status: "completed",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("c"),
				tool: "exec_command",
				input: JSON.stringify({ cmd: "pytest -q" }),
				status: "completed",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("d"),
				tool: "write",
				input: JSON.stringify({ path: "/tmp/check/tests/recompute.py" }),
				status: "completed",
			},
		];
		const ran = executedCommands(items);
		expect(ran).toEqual(["make test", `${REPRO} --v "x"`, "pytest -q"]);
		// Written but never run: not shown.
		expect(commandWasRun(RECOMPUTE, ran)).toBe(false);
		// Tolerant: whitespace, a part of a run command, a cd step run apart.
		expect(commandWasRun(`  ${REPRO.replace(" ", "   ")} `, ran)).toBe(true);
		expect(
			commandWasRun("cd /tmp/check && make test", [...ran, "cd /tmp/check"]),
		).toBe(true);
		expect(commandWasRun(`python3 /tmp/check/tests/repro_get.py -x`, ran)).toBe(
			true,
		);
		expect(commandWasRun("", ran)).toBe(false);
	});

	it("keeps a failure whose command it ran, and sets aside one it did not run", () => {
		const verdict = groundReviewVerdict(review(FAIL), [
			`cd /tmp/check && ${RECOMPUTE}`,
			REPRO,
			"ls /app/out.json",
		]);
		expect(verdict.verdict).toBe("fail");
		expect(verdict.failures).toEqual([
			"precedence: rule 2 outranks rule 5 (ran `python3 /tmp/check/tests/recompute.py` -> expected a.txt, got b.txt)",
		]);
		expect(verdict.downgraded).toEqual([
			"units: the output is in ms, the spec says seconds",
		]);
		expect(verdict.notes).toContain(
			"(Set aside: no command the checker ran shows these.) units: the output is in ms",
		);
		// The unmet requirement it ran stands as a finding.
		expect(reviewFindings(verdict).map((finding) => finding.text)).toEqual([
			FAIL.failures[0] &&
				"precedence: rule 2 outranks rule 5 (ran `python3 /tmp/check/tests/recompute.py` -> expected a.txt, got b.txt)",
			"writes /app/out.json: No such file (ran `ls /app/out.json`)",
		]);
	});

	it("downgrades every unrun finding to a note: a fail with nothing shown becomes pass when its tests ran", () => {
		const verdict = groundReviewVerdict(review(FAIL), [REPRO]);
		expect(verdict.failures).toEqual([]);
		expect(verdict.downgraded).toHaveLength(3);
		expect(verdict.requirements[1].met).toBeNull();
		expect(verdict.verdict).toBe("pass");
		expect(verdict.ungrounded).toBeUndefined();
		expect(reviewFindings(verdict)).toEqual([]);
		// A fail shown by nothing it ran: no verdict, retried.
		const none = groundReviewVerdict(review(FAIL), []);
		expect(none.verdict).toBe("unsure");
		expect(none.ungrounded).toBe(true);
	});

	it("keeps a failing test it ran as the finding when the listed ones were not run, and never hands over an unrun test", () => {
		const verdict = groundReviewVerdict(
			review({
				verdict: "fail",
				failures: ["ordering is wrong"],
				tests: [
					{ name: "order", command: REPRO, passed: false, output: "2 1" },
					{ name: "never ran", command: RECOMPUTE, passed: false },
				],
			}),
			[REPRO],
		);
		expect(verdict.verdict).toBe("fail");
		expect(verdict.failures).toEqual(["order: 2 1"]);
		expect(verdict.downgraded).toEqual(["ordering is wrong"]);
		expect(failingTests(verdict).map((test) => test.name)).toEqual(["order"]);
	});

	it("a failure naming a failing test it ran, or citing a run command inline, stands", () => {
		const verdict = groundReviewVerdict(
			review({
				verdict: "fail",
				failures: [
					"order: newest first is broken",
					"limit: `python3 /tmp/check/tests/limit.py` printed 11 rows",
				],
				tests: [{ name: "order", command: REPRO, passed: false }],
			}),
			[REPRO, "python3 /tmp/check/tests/limit.py"],
		);
		expect(verdict.failures).toHaveLength(2);
		expect(verdict.downgraded).toEqual([]);
	});

	it("a pass with no executed verification is no verdict, and the loop checks again once", () => {
		const claimed = review({
			verdict: "pass",
			failures: [],
			tests: [{ name: "edge", command: REPRO, passed: true }],
			requirements: [{ requirement: "r", met: true, command: REPRO }],
		});
		expect(claimed.verdict).toBe("pass");
		const ungrounded = groundReviewVerdict(claimed, ["ls /app"]);
		expect(ungrounded).toMatchObject({ verdict: "unsure", ungrounded: true });
		expect(ungrounded.notes).toContain(UNGROUNDED_PASS_NOTE);
		expect(ungrounded.tests[0].unrun).toBe(true);
		const at = { now: 0, deadlineAt: 3_600_000 };
		expect(retryCheck({ verdict: ungrounded, rounds: [], ...at })).toBe(true);
		// Verified by what it ran: the pass stands.
		const grounded = groundReviewVerdict(claimed, [REPRO]);
		expect(grounded.verdict).toBe("pass");
		expect(retryCheck({ verdict: grounded, rounds: [], ...at })).toBe(false);
		// A pass without tests of its own and nothing run is no verdict too.
		expect(
			groundReviewVerdict(review({ verdict: "pass", failures: [] }), [])
				.ungrounded,
		).toBe(true);
	});

	it("leaves the verdict as parsed when the checker's log is unavailable", () => {
		const parsed = review(FAIL);
		expect(groundReviewVerdict(parsed, null)).toBe(parsed);
	});

	it("counts set-aside findings in the review summary", () => {
		const verdict = groundReviewVerdict(review(FAIL), [RECOMPUTE, REPRO]);
		const state = {
			rounds: [
				{ n: 1, verdict, findings: reviewFindings(verdict), checker: {} },
			],
		} as unknown as ReviewLoopState;
		expect(reviewLoopSummary(state)).toBe(
			"Review 1: fail (1 finding) · 2 not run, set aside",
		);
	});
});
