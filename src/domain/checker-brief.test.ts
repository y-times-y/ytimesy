import { describe, expect, it } from "vitest";
import { truncatedVerdictJson } from "./attempt-loop";
import {
	checkerDeadlineNotice,
	checkerWrapUpLeadMs,
	independentReviewBrief,
	parseReviewVerdict,
} from "./checker-brief";

const input = {
	taskText: "Write `/app/out.json` with the field `total`.\nKeep it exact.",
	checkout: "/app",
	changedFiles: ["out.json", "make.py"],
	outsideFiles: ["/results/report.csv"],
	scratch: "/tmp/check",
};

describe("independentReviewBrief", () => {
	it("carries the request verbatim, the deliverable and the four review parts", () => {
		const brief = independentReviewBrief(input);
		expect(brief).toContain(`<request>\n${input.taskText}\n</request>`);
		expect(brief).toContain("files changed by the run: out.json, make.py");
		expect(brief).toContain(
			"Files the run delivered outside it: /results/report.csv.",
		);
		expect(brief).toContain("cp -a /app /tmp/check/work");
		for (const part of [
			"1. Requirements.",
			"2. Assumptions.",
			"3. Plausibility.",
			"4. Exercise it as an outside grader would.",
		])
			expect(brief).toContain(part);
		expect(brief).toContain('"verdict": "pass" | "fail" | "unsure"');
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
