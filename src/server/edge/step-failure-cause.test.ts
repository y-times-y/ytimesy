import { expect, it } from "vitest";
import { stepFailureCause } from "./step-failure-cause";

it("names the error and where it was thrown, bounded", () => {
	const cause = stepFailureCause(new TypeError("items is not iterable"));
	expect(cause).toContain("TypeError: items is not iterable");
	expect(cause).toContain("@");
	expect(cause.length).toBeLessThanOrEqual(800);
});

it("redacts secrets and accepts a thrown non-error", () => {
	expect(stepFailureCause("boom Bearer abcdefghijklmnop123")).not.toContain(
		"abcdefghijklmnop123",
	);
	expect(stepFailureCause(undefined)).toBe("undefined");
});

it("never throws", () => {
	const hostile = {
		toString() {
			throw new Error("no");
		},
	};
	expect(stepFailureCause(hostile)).toBe("unreadable error");
});
