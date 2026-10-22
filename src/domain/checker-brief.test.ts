import { describe, expect, it } from "vitest";
import { truncatedVerdictJson } from "./attempt-loop";
import {
	checkerDeadlineNotice,
	checkerStandingRules,
	checkerWrapUpLeadMs,
	independentReviewBrief,
	parseReviewVerdict,
	reviewBriefRequest,
	UNTESTED_PASS_NOTE,
} from "./checker-brief";

const input = {
	taskText: "Write `/app/out.json` with the field `total`.\nKeep it exact.",
	checkout: "/app",
	changedFiles: ["out.json", "make.py"],
	outsideFiles: ["/results/report.csv"],
	scratch: "/tmp/check",
};

describe("independentReviewBrief", () => {
	it("adds the rigor checks only with rigor=on", () => {
		const plain = independentReviewBrief(input);
		const rigor = independentReviewBrief({ ...input, rigor: true });
		for (const check of [
			"look in the deliverable (files, comments, docs, output) for assumptions or interpretations it states",
			"the reading the convention of the library, ecosystem or standard involved gives (the strictest reading only when no convention applies)",
			"Run it once as an outside user would: a fresh shell in a clean directory holding only the files the request names",
			"never helpers the builder wrote",
			"A deliverable that itself admits unverified, failing or skipped parts (in its files, notes or output) is fail",
		]) {
			expect(rigor).toContain(check);
			expect(plain).not.toContain(check);
		}
	});

	it("adds the builder's requirements list only with rigor=on, as a claim compared after the checker's own list", () => {
		const builderRequirements = ["out.json has a total field", "units: ms"];
		const plain = independentReviewBrief({ ...input, builderRequirements });
		const none = independentReviewBrief({ ...input, rigor: true });
		const rigor = independentReviewBrief({
			...input,
			rigor: true,
			builderRequirements,
		});
		for (const brief of [plain, none]) {
			expect(brief).not.toContain("builder_requirements");
			expect(brief).not.toContain("builder's understanding");
		}
		expect(rigor).toContain(
			"Then, and only then, compare your list with the builder's understanding of the requirements at the end of this brief: it is the builder's claim, not ground truth",
		);
		expect(rigor).toContain(
			"never drop one of yours because the builder's list lacks it",
		);
		expect(rigor).toContain(
			"<builder_requirements>\nThe builder's understanding of the requirements, written before it worked (a claim to compare, not ground truth):\n- out.json has a total field\n- units: ms\n</builder_requirements>",
		);
		expect(rigor.indexOf("4. Test it yourself.")).toBeLessThan(
			rigor.indexOf("<builder_requirements>"),
		);
	});

	it("carries the request verbatim, the deliverable and the four review parts", () => {
		const brief = independentReviewBrief(input);
		expect(brief).toContain(`<request>\n${input.taskText}\n</request>`);
		expect(brief).toContain("files changed by the run: out.json, make.py");
		expect(brief).toContain(
			"Files the run delivered outside it: /results/report.csv.",
		);
		// The checkout path is often a symbolic link (~/<project> -> /app on a
		// hard-set VM): copying the link itself left the checker a "copy" that
		// was the read-only original (rl-tests-luna), so the contents are copied.
		expect(brief).toContain(
			"mkdir -p /tmp/check/work && cp -a /app/. /tmp/check/work/",
		);
		expect(brief).not.toContain("cp -a /app /tmp/check/work");
		for (const part of [
			"1. Requirements.",
			"2. Assumptions.",
			"3. Plausibility.",
			"4. Test it yourself.",
		])
			expect(brief).toContain(part);
		expect(brief).toContain('"verdict": "pass" | "fail" | "unsure"');
	});

	it("requires new tests of its own: existing tests are necessary, not sufficient", () => {
		const brief = independentReviewBrief(input);
		expect(brief).toMatch(
			/existing tests passed for the builder too and are not enough/,
		);
		expect(brief).toContain(
			"For each requirement and each risky change in the diff, write at least one new test or executable probe of your own under /tmp/check/tests",
		);
		expect(brief).toContain("cases the existing tests do not cover");
		expect(brief).toContain(
			"Run your tests against your copy, then the existing tests",
		);
		// Each test is reported: what it checks, the command, the result.
		expect(brief).toContain(
			'"tests": [{ "name": "<what it checks>", "command": "<one command that runs it, absolute paths>", "passed": true, "probe": false, "output": "<the lines that show the result>" }]',
		);
		// The verdict rules.
		expect(brief).toContain(
			"pass when a command you ran shows each stated requirement met and your non-probe tests and the existing checks pass",
		);
		expect(brief).toContain(
			"fail only when a command you ran shows the deliverable breaking something the request or its files state",
		);
		expect(brief).toContain("a failed probe is a note, not a failure");
		expect(brief).toContain(
			"a pass without new tests of your own counts as unsure",
		);
		expect(brief).toContain(
			"unsure only when you genuinely could not run what matters; say why in notes",
		);
		// Generic: nothing about a task or a domain beyond the request itself.
		expect(brief).not.toMatch(/mvcc|lsm|compaction|flush/i);
	});

	it("checks each stated symptom through the existing API first, over code comments, and fails output-changing readings", () => {
		const brief = independentReviewBrief(input);
		expect(brief).toContain(
			"1. Requirements. Before anything else, and before reading the deliverable's notes or rationale, list each symptom or requirement the request itself states and mark it fixed or not fixed by running a reproduction through the existing public API and entry points, the calls a normal caller makes (hidden tests use them).",
		);
		expect(brief).toContain(
			"A stated symptom not fixed that way is a failure, whatever docstrings, comments or the deliverable's notes say; a fix that needs new methods, flags, protocols or extra caller calls does not fix it.",
		);
		expect(brief).toContain(
			"Where a result hinges on one, run the deliverable or a script under the alternative reading. A credible alternative reading that the run shows changes the output is a failure (both readings, the output each gives)",
		);
	});

	it("has the checker re-derive key outputs before reading the deliverable's rationale, and fail a departure from the convention", () => {
		const brief = independentReviewBrief(input);
		expect(brief).toContain(
			"Before reading any rationale the deliverable states, write and run a script under /tmp/check/tests that derives each key output from the governing rule or procedure in the request and its files (enumerated lists, precedence orders, required-type tables, the convention of the library or standard involved) and diffs it against the deliverable's. A mismatch that script shows, and the deliverable's reasoning does not refute from the source text, is a failure.",
		);
		expect(brief).toContain(
			'An explicit list or precedence order beats general guidance such as "minimal" or "avoid redundancy".',
		);
		expect(brief).toContain(
			"and so is a departure from the convention of the library, ecosystem or standard involved (say to switch to it); having no oracle is not grounds to pass.",
		);
		// The request and the deliverable come before any claim of the builder's.
		const rigor = independentReviewBrief({
			...input,
			rigor: true,
			builderRequirements: ["x"],
		});
		expect(rigor.indexOf("<request>")).toBeLessThan(
			rigor.indexOf("<builder_requirements>"),
		);
	});

	it("says when no changed files were recorded and caps long lists", () => {
		expect(
			independentReviewBrief({ ...input, changedFiles: [], outsideFiles: [] }),
		).toContain("The working directory /app (no changed files recorded).");
		const many = Array.from({ length: 250 }, (_, index) => `f${index}`);
		const brief = independentReviewBrief({ ...input, changedFiles: many });
		expect(brief).toContain("f199, ...");
		expect(brief).not.toContain("f200");
	});
});

describe("parseReviewVerdict", () => {
	it("reads the verdict, failures, requirements and assumptions", () => {
		const verdict = parseReviewVerdict(
			`Done.\n${JSON.stringify({
				verdict: "fail",
				failures: ["total: off by one (out.json says 9, inputs sum to 10)"],
				requirements: [
					{ requirement: "out.json exists", met: true, evidence: "ls" },
					{ requirement: "total exact", met: false, evidence: "9 vs 10" },
				],
				assumptions: [
					{
						assumption: "inclusive range",
						alternative: "exclusive",
						outcome: "10",
					},
				],
				notes: "n",
			})}`,
		);
		expect(verdict.verdict).toBe("fail");
		expect(verdict.failures).toEqual([
			"total: off by one (out.json says 9, inputs sum to 10)",
		]);
		expect(verdict.requirements).toHaveLength(2);
		expect(verdict.requirements[1]).toEqual({
			requirement: "total exact",
			met: false,
			evidence: "9 vs 10",
		});
		expect(verdict.assumptions[0].alternative).toBe("exclusive");
	});

	it("turns unmet requirements into failures and a pass with them into unsure", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "pass",
				failures: [],
				requirements: [
					{ requirement: "total exact", met: false, evidence: "9" },
				],
			}),
		);
		expect(verdict.verdict).toBe("unsure");
		expect(verdict.failures).toEqual(["total exact: 9"]);
	});

	it("keeps a clean pass and treats a missing answer as unsure", () => {
		expect(
			parseReviewVerdict(
				JSON.stringify({
					verdict: "pass",
					failures: [],
					tests: [{ name: "empty input", command: "c", passed: true }],
					requirements: [{ requirement: "r", met: true, evidence: "e" }],
				}),
			).verdict,
		).toBe("pass");
		const missing = parseReviewVerdict("I ran out of time.");
		expect(missing.verdict).toBe("unsure");
		expect(missing.parsed).toBe(false);
		expect(missing.requirements).toEqual([]);
	});
});

describe("the checker's own tests", () => {
	it("reads each test: what it checks, its command, its result and output", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "fail",
				failures: ["total exact: off by one (test: sum of inputs)"],
				tests: [
					{
						name: "sum of inputs",
						command: "python3 /tmp/check/tests/sum.py /tmp/check/work",
						passed: false,
						output: "expected 10\ngot 9",
					},
					{ checks: "empty input", command: "c2", result: "pass" },
					{ name: "no result" },
				],
			}),
		);
		expect(verdict.tests).toEqual([
			{
				name: "sum of inputs",
				passed: false,
				command: "python3 /tmp/check/tests/sum.py /tmp/check/work",
				output: "expected 10\ngot 9",
			},
			{ name: "empty input", passed: true, command: "c2" },
		]);
		expect(verdict.untested).toBeUndefined();
	});

	it("counts a pass without any new test as unsure, and flags it", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "pass",
				failures: [],
				requirements: [
					{ requirement: "r", met: true, evidence: "make test passed" },
				],
				notes: "existing tests pass",
			}),
		);
		expect(verdict.verdict).toBe("unsure");
		expect(verdict.untested).toBe(true);
		expect(verdict.notes).toBe(`${UNTESTED_PASS_NOTE} existing tests pass`);
		// A fail or unsure without tests stays as it is.
		for (const kind of ["fail", "unsure"] as const) {
			const other = parseReviewVerdict(
				JSON.stringify({ verdict: kind, failures: ["x: y"] }),
			);
			expect(other.verdict).toBe(kind);
			expect(other.untested).toBeUndefined();
		}
	});

	it("never passes when one of its own tests failed, and reports it as a failure", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "pass",
				tests: [
					{ name: "a", command: "c", passed: true },
					{ name: "b", command: "d", passed: false, output: "boom" },
				],
			}),
		);
		expect(verdict.verdict).toBe("unsure");
		expect(verdict.failures).toEqual(["b: boom"]);
	});

	it("still reads an older answer without tests (legacy fields)", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "fail",
				failures: ["x"],
				tests: [{ name: "n", passed: false, evidence: "e" }],
			}),
		);
		expect(verdict.tests).toEqual([
			{ name: "n", passed: false, evidence: "e" },
		]);
	});
});

describe("a checker answer cut off or wrapped", () => {
	const full = {
		verdict: "unsure",
		failures: ["speedup: 2009x on relabeled pairs, 5000x required"],
		requirements: [
			{ requirement: "importable package", met: true, evidence: "import ok" },
			{ requirement: "5000x speedup", met: false, evidence: "2009x" },
			{ requirement: "matches networkx", met: true, evidence: "diffed" },
		],
		assumptions: [{ assumption: "a", alternative: "b", outcome: "c" }],
		notes: "n",
	};

	it("salvages the complete part of a verdict cut off mid-answer", () => {
		const text = JSON.stringify(full, null, 2);
		const cut = text.slice(0, text.indexOf('"matches networkx"') + 6);
		const verdict = parseReviewVerdict(`Report:\n${cut}`);
		expect(verdict.parsed).toBe(true);
		expect(verdict.truncated).toBe(true);
		expect(verdict.verdict).toBe("unsure");
		expect(verdict.failures).toEqual(full.failures);
		expect(verdict.requirements.map((entry) => entry.requirement)).toEqual([
			"importable package",
			"5000x speedup",
		]);
		expect(verdict.notes).toMatch(/cut off/);
		expect(truncatedVerdictJson("no json")).toBeNull();
		expect(truncatedVerdictJson('{"verdict": "fa')).toBeNull();
	});

	it("never trusts a pass that was cut off", () => {
		const text = JSON.stringify({ ...full, verdict: "pass", failures: [] });
		const verdict = parseReviewVerdict(
			text.slice(0, text.indexOf("assumptions")),
		);
		expect(verdict.truncated).toBe(true);
		expect(verdict.verdict).toBe("unsure");
	});

	it("reads fenced JSON and prefers a complete verdict over a cut-off one", () => {
		const fenced = `Done.\n\`\`\`json\n${JSON.stringify({ ...full, verdict: "fail" })}\n\`\`\`\nThanks.`;
		expect(parseReviewVerdict(fenced)).toMatchObject({
			verdict: "fail",
			parsed: true,
		});
		expect(parseReviewVerdict(fenced).truncated).toBeUndefined();
		const both = `${JSON.stringify({ ...full, verdict: "fail" })}\n${JSON.stringify(full).slice(0, 80)}`;
		expect(parseReviewVerdict(both).verdict).toBe("fail");
	});

	it("asks for the verdict well before the limit", () => {
		expect(checkerWrapUpLeadMs(7 * 60_000)).toBe(90_000);
		expect(checkerWrapUpLeadMs(12 * 60_000)).toBe(144_000);
		expect(checkerWrapUpLeadMs(60_000)).toBe(30_000);
		expect(checkerDeadlineNotice(91.4)).toContain("about 91 seconds");
		expect(checkerDeadlineNotice(10)).toContain("only the JSON");
	});

	it("names the diff command when given", () => {
		expect(
			independentReviewBrief({
				...input,
				diffCommand: "git -C /app diff base head",
			}),
		).toContain("`git -C /app diff base head` shows the whole change.");
	});
});

describe("the project's remembered rules for a checker", () => {
	it("are labelled as the user's own standing rules, each a requirement to check", () => {
		const text = checkerStandingRules({
			rules: ["New entity IDs use ULIDs"],
			related: ["- Store timestamps in UTC [added: 2026-10-01]"],
		});
		expect(text).toContain("The user's standing rules for this project");
		expect(text).toContain("not the builder's claims");
		expect(text).toContain('"follows the project\'s remembered rules"');
		expect(text).toContain("- New entity IDs use ULIDs\n</standing_rules>");
		expect(text).toContain("<remembered>");
		expect(checkerStandingRules({ rules: [], related: [] })).toBe("");
	});

	it("are recalled for the user's request, not the generic brief", () => {
		expect(reviewBriefRequest(independentReviewBrief(input))).toBe(
			input.taskText,
		);
		expect(reviewBriefRequest("Find the export code")).toBeNull();
	});
});
