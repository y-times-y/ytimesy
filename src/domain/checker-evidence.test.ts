import { describe, expect, it } from "vitest";
import { findingsFileVerdict, parseReviewVerdict } from "./checker-brief";
import {
	commandWasRun,
	defaultPassVerdict,
	executedCommands,
	groundReviewVerdict,
	harnessCommands,
	harnessGrounded,
	NOT_VERIFIED_NOTE,
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
		// A fail shown by nothing it ran: an ungrounded pass, never unsure.
		const none = groundReviewVerdict(review(FAIL), []);
		expect(none.verdict).toBe("pass");
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

	it("a pass with no executed verification is ungrounded, and the loop checks again once", () => {
		const claimed = review({
			verdict: "pass",
			failures: [],
			tests: [{ name: "edge", command: REPRO, passed: true }],
			requirements: [{ requirement: "r", met: true, command: REPRO }],
		});
		expect(claimed.verdict).toBe("pass");
		const ungrounded = groundReviewVerdict(claimed, ["ls /app"]);
		expect(ungrounded).toMatchObject({ verdict: "pass", ungrounded: true });
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

	it("the loop runs the checker's run.sh, tests and named checks to ground a pass", () => {
		const claimed = groundReviewVerdict(
			review({
				verdict: "pass",
				failures: [],
				tests: [
					{ name: "edge", command: REPRO, passed: true },
					{
						name: "huge",
						command: "python3 /tmp/x/probe.py",
						passed: true,
						probe: true,
					},
				],
				requirements: [
					{ requirement: "r", met: true, command: "make -C /app test" },
					{ requirement: "s", met: false, command: "ls /nope" },
				],
			}),
			[],
		);
		expect(claimed.ungrounded).toBe(true);
		expect(harnessCommands(claimed, "/tmp/check")).toEqual([
			{
				command:
					"test -f /tmp/check/tests/run.sh && bash /tmp/check/tests/run.sh",
				test: true,
			},
			{ command: REPRO, test: true },
			{ command: "make -C /app test", test: false },
		]);
		const absent = {
			command:
				"test -f /tmp/check/tests/run.sh && bash /tmp/check/tests/run.sh",
			exitCode: 1,
			output: "",
			test: true,
		};
		// Its test passes when the loop runs it: a grounded pass.
		const passed = harnessGrounded(claimed, [
			absent,
			{ command: REPRO, exitCode: 0, output: "ok", test: true },
		]);
		expect(passed).toMatchObject({ verdict: "pass", via: "harness-grounded" });
		expect(passed.ungrounded).toBeUndefined();
		expect(passed.harnessRuns).toHaveLength(2);
		// Its test fails when the loop runs it: a fail with that evidence.
		const failed = harnessGrounded(claimed, [
			{
				command: REPRO,
				exitCode: 1,
				output: "AssertionError: 2 != 3",
				test: true,
			},
		]);
		expect(failed.verdict).toBe("fail");
		expect(failed.failures[0]).toContain("AssertionError: 2 != 3");
		expect(reviewFindings(failed)).toHaveLength(1);
		// Nothing ran (run.sh absent, nothing else): still ungrounded.
		const nothing = harnessGrounded(claimed, [absent]);
		expect(nothing.ungrounded).toBe(true);
		expect(nothing.via).toBeUndefined();
	});

	it("ungrounded after a retry: pass with the note, never unsure", () => {
		const ungrounded = groundReviewVerdict(
			review({ verdict: "pass", failures: [] }),
			[],
		);
		const verdict = defaultPassVerdict(ungrounded);
		expect(verdict).toMatchObject({
			verdict: "pass",
			via: "default-pass",
			parsed: true,
			failures: [],
		});
		expect(verdict.ungrounded).toBeUndefined();
		expect(verdict.notes.startsWith(NOT_VERIFIED_NOTE)).toBe(true);
		expect(defaultPassVerdict(null)).toMatchObject({
			verdict: "pass",
			notes: NOT_VERIFIED_NOTE,
		});
		const state = {
			rounds: [{ n: 1, verdict, findings: [], checker: {} }],
		} as unknown as ReviewLoopState;
		expect(reviewLoopSummary(state)).toBe(
			"Review 1: pass · not verified by running",
		);
	});

	it("a findings file is a verdict, grounded like an answer; its own appends are not runs", () => {
		const file = [
			JSON.stringify({
				requirement: "get returns the newest",
				met: true,
				command: REPRO,
				output: "ok",
			}),
			"not json",
			JSON.stringify({
				failure: "units: ms, not seconds",
				command: RECOMPUTE,
				output: "1500",
			}),
			JSON.stringify({
				requirement: "writes /app/out.json",
				met: false,
				command: "ls /app/out.json",
				output: "No such file",
			}),
		].join("\n");
		const verdict = findingsFileVerdict(file);
		expect(verdict?.verdict).toBe("fail");
		expect(verdict?.failures).toHaveLength(2);
		expect(findingsFileVerdict("")).toBeNull();
		expect(findingsFileVerdict("garbage\n{}")).toBeNull();
		// Appending a finding cites its command; only the real run counts.
		const appended = `echo '{"failure":"units","command":"${RECOMPUTE}"}' >> /tmp/check/findings.jsonl`;
		const executed = executedCommands([
			{
				kind: "commandExecution",
				id: SessionItemId("a"),
				command: appended,
				status: "completed",
			} as SessionItem,
		]);
		expect(executed).toEqual([]);
		const grounded = groundReviewVerdict(
			verdict as NonNullable<typeof verdict>,
			[REPRO, RECOMPUTE],
		);
		expect(grounded.verdict).toBe("fail");
		expect(grounded.failures).toEqual([
			"units: ms, not seconds (ran `python3 /tmp/check/tests/recompute.py` -> 1500)",
		]);
		expect(
			findingsFileVerdict(
				JSON.stringify({ requirement: "r", met: true, command: REPRO }),
			)?.verdict,
		).toBe("pass");
	});
});
