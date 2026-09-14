import { describe, expect, it } from "vitest";
import { diffPreviewLines, fileChangeTotals } from "./diff-preview";

describe("diffPreviewLines", () => {
	it("treats a whole-file add as added lines", () => {
		expect(
			diffPreviewLines({
				path: "todo.py",
				change: "add",
				additions: 2,
				deletions: 0,
				preview: "print(1)\nprint(2)\n",
			}),
		).toEqual([
			{ kind: "add", text: "print(1)", number: 1 },
			{ kind: "add", text: "print(2)", number: 2 },
			{ kind: "add", text: "", number: 3 },
		]);
	});

	it("parses unified diffs into add, delete, and context lines", () => {
		expect(
			diffPreviewLines({
				path: "src/hero.tsx",
				change: "update",
				additions: 1,
				deletions: 1,
				preview:
					"--- a/src/hero.tsx\n+++ b/src/hero.tsx\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n",
			}),
		).toEqual([
			{ kind: "ctx", text: "keep", number: 1 },
			{ kind: "del", text: "old", number: 2 },
			{ kind: "add", text: "new", number: 3 },
		]);
	});
});

describe("fileChangeTotals", () => {
	it("sums additions and deletions across files", () => {
		expect(
			fileChangeTotals([
				{
					path: "a.py",
					change: "add",
					additions: 88,
					deletions: 0,
					preview: null,
				},
				{
					path: "b.md",
					change: "add",
					additions: 25,
					deletions: 3,
					preview: null,
				},
			]),
		).toEqual({ additions: 113, deletions: 3 });
	});
});
