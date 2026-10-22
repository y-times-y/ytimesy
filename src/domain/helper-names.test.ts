import { describe, expect, it } from "vitest";
import {
	HELPER_COLORS,
	helperColor,
	helperIdentitiesOf,
	helperName,
	helperReference,
	helperShortName,
} from "./helper-names";

describe("helper short names", () => {
	it("names every kind by its tag, lowercased, and its number", () => {
		expect(helperShortName("sidekick", 1)).toBe("build-1");
		expect(helperShortName("writer", 2)).toBe("build-2");
		expect(helperShortName("researcher", 1)).toBe("research-1");
		expect(helperShortName("reviewer", 1)).toBe("review-1");
		expect(helperShortName("checker", 3)).toBe("verify-3");
	});
	it("tells the lead the short name with the task", () => {
		expect(helperReference("review-1", "Review the patch")).toBe(
			'review-1 ("Review the patch")',
		);
	});
	it("cuts a long task title cleanly at a word", () => {
		expect(
			helperName(
				"Investigate why the nightly export job drops rows with null customer ids",
			),
		).toBe("Investigate why the nightly export…");
		expect(helperName("  ")).toBe("Untitled task");
	});
});

describe("helper colours", () => {
	it("cycles red, lime, blue, orange, yellow in start order", () => {
		expect(HELPER_COLORS).toEqual([
			"#F43F5E",
			"#A3E635",
			"#60A5FA",
			"#F97316",
			"#FACC15",
		]);
		expect(helperColor(0)).toBe("#F43F5E");
		expect(helperColor(4)).toBe("#FACC15");
		expect(helperColor(7)).toBe("#60A5FA");
	});
	it("numbers and colours helpers by start order, whatever order they come in", () => {
		const helpers = [
			{ id: "c", createdAt: "2026-10-21T10:02:00Z", kind: "writer" },
			{ id: "a", createdAt: "2026-10-21T10:00:00Z", kind: "researcher" },
			{ id: "b", createdAt: "2026-10-21T10:01:00Z", kind: "researcher" },
		] as const;
		const ids = helperIdentitiesOf(
			helpers.map((helper) => ({ ...helper, title: `Task ${helper.id}` })),
		);
		expect([...ids.entries()].map(([id, identity]) => [id, identity])).toEqual([
			[
				"a",
				{
					name: "research-1",
					task: "Task a",
					kind: "researcher",
					icon: "search",
					color: "#F43F5E",
				},
			],
			[
				"b",
				{
					name: "research-2",
					task: "Task b",
					kind: "researcher",
					icon: "search",
					color: "#A3E635",
				},
			],
			[
				"c",
				{
					name: "build-1",
					task: "Task c",
					kind: "writer",
					icon: "hammer",
					color: "#60A5FA",
				},
			],
		]);
	});
});
