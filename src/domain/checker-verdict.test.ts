import { describe, expect, it } from "vitest";
import { parseCheckerVerdict } from "./checker-verdict";

describe("probe tests", () => {
	it("a failed probe beyond the request never blocks a pass or becomes a finding", () => {
		const parsed = parseCheckerVerdict(
			JSON.stringify({
				verdict: "pass",
				failures: [],
				tests: [
					{ name: "stated format", command: "c1", passed: true },
					{ name: "huge input", command: "c2", passed: false, probe: true },
				],
			}),
		);
		expect(parsed.verdict).toBe("pass");
		expect(parsed.failures).toEqual([]);
		expect(parsed.tests[1]).toMatchObject({ probe: true, passed: false });
	});
	it("a failed non-probe test still turns a pass into unsure", () => {
		const parsed = parseCheckerVerdict(
			JSON.stringify({
				verdict: "pass",
				failures: [],
				tests: [{ name: "stated format", command: "c1", passed: false }],
			}),
		);
		expect(parsed.verdict).toBe("unsure");
	});
});
