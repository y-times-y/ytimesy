import { describe, expect, it } from "vitest";
import { independentReviewBrief, parseReviewVerdict } from "./checker-brief";

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
