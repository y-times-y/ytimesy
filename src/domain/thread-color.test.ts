import { describe, expect, it } from "vitest";
import { HELPER_COLORS, helperColor } from "./helper-names";
import { threadColor } from "./thread-color";

describe("a thread's colour", () => {
	it("is the agent colour for its place in the project: thread 1 takes the first, 2 the second", () => {
		expect(threadColor({ id: "a", threadNumber: 1 })).toBe(helperColor(0));
		expect(threadColor({ id: "b", threadNumber: 2 })).toBe(helperColor(1));
		expect(threadColor({ id: "c", threadNumber: 5 })).toBe(HELPER_COLORS[4]);
	});

	it("repeats after ten, as agents' colours do", () => {
		expect(threadColor({ id: "a", threadNumber: 11 })).toBe(
			threadColor({ id: "b", threadNumber: 1 }),
		);
	});

	it("gives neighbouring threads different colours", () => {
		for (let number = 1; number < 40; number++)
			expect(threadColor({ id: "x", threadNumber: number })).not.toBe(
				threadColor({ id: "x", threadNumber: number + 1 }),
			);
	});

	it("does not depend on the id when it has a number, and is stable without one", () => {
		expect(threadColor({ id: "one", threadNumber: 7 })).toBe(
			threadColor({ id: "two", threadNumber: 7 }),
		);
		const id = "3f9a2b1c-7d4e-4f10-9a55-0c2d8e6b1a77";
		expect(threadColor({ id })).toBe(threadColor({ id, threadNumber: null }));
		expect(HELPER_COLORS as readonly string[]).toContain(threadColor({ id }));
	});
});
