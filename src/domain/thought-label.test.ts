import { describe, expect, it } from "vitest";
import { thoughtLabel } from "./thought-label";

describe("thoughtLabel", () => {
	it("matches Cursor's Thought for N seconds copy", () => {
		expect(thoughtLabel({ durationSeconds: 6 })).toBe("Thought for 6 seconds");
		expect(thoughtLabel({ durationSeconds: 1 })).toBe("Thought for 1 second");
		expect(thoughtLabel({ inProgress: true })).toBe("Thinking");
		expect(thoughtLabel({})).toBe("Thought");
	});
});
