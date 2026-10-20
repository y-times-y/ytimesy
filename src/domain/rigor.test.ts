import { describe, expect, it } from "vitest";
import { admittedUnverified, RIGOR_BUILDER_INSTRUCTIONS } from "./rigor";

describe("rigor", () => {
	it("finds the lines of a final answer that admit unverified or failing work", () => {
		expect(
			admittedUnverified(
				[
					"Implemented the parser; `make test` exits 0.",
					"Unverified: the Windows path was not tested.",
					"I couldn't verify the upload against the live service.",
					"The flaky integration test still fails.",
				].join("\n"),
			),
		).toEqual([
			"Unverified: the Windows path was not tested.",
			"I couldn't verify the upload against the live service.",
			"The flaky integration test still fails.",
		]);
	});

	it("ignores answers that say nothing is unverified", () => {
		expect(
			admittedUnverified(
				"Done; all checks pass.\nUnverified: none.\nNothing is left unverified.\n- Remaining risks: none",
			),
		).toEqual([]);
	});

	it("keeps the builder block general", () => {
		expect(RIGOR_BUILDER_INSTRUCTIONS).toContain(
			"Prefer the convention of the library, ecosystem or standard involved; otherwise the strictest reading.",
		);
		expect(RIGOR_BUILDER_INSTRUCTIONS).toContain(
			"run the deliverable as an outside user would",
		);
	});
});
