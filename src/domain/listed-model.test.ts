import { describe, expect, it } from "vitest";
import { preferredListedModelId, submittedListedModelId } from "./listed-model";

describe("submittedListedModelId", () => {
	const listed = [
		{ id: "opencode/nemotron-3-ultra-free" },
		{ id: "opencode/muse-spark-1.3-contributor-free" },
	];

	it("keeps a requested id that the connected catalog listed", () => {
		expect(
			submittedListedModelId("opencode/nemotron-3-ultra-free", listed),
		).toBe("opencode/nemotron-3-ultra-free");
	});

	it("picks a listed Zen spark when the client has no model yet", () => {
		expect(submittedListedModelId("", listed)).toBe(
			"opencode/muse-spark-1.3-contributor-free",
		);
		expect(submittedListedModelId("invented/not-listed", listed)).toBe(
			"opencode/muse-spark-1.3-contributor-free",
		);
	});

	it("does not invent an id when the catalog is empty", () => {
		expect(submittedListedModelId("", [])).toBe("");
		expect(preferredListedModelId([])).toBe("");
	});
});
