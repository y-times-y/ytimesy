import { describe, expect, it } from "vitest";
import { diffPreviewHunks, fileChangeTotals } from "./diff-preview";
import type { FileChangeEntry } from "./session-item";

const diffPreviewLines = (change: FileChangeEntry) =>
	diffPreviewHunks(change).flatMap((hunk) => hunk.lines);

describe("diffPreviewLines", () => {
	it("keeps hunk boundaries and caps the preview across hunks", () => {
		const hunks = diffPreviewHunks({
			path: "a.ts",
			change: "update",
			additions: 401,
			deletions: 0,
			preview: `@@ -0,0 +1,400 @@\n${Array.from({ length: 400 }, () => "+line\n").join("")}@@ -20,0 +421,1 @@\n+last\n`,
		});
		expect(hunks).toHaveLength(1);
		expect(hunks[0].lines).toHaveLength(400);
	});
	it("keeps source offsets across separate hunks and skips no-newline metadata", () => {
		const lines = diffPreviewLines({
			path: "a.ts",
			change: "update",
			additions: 2,
			deletions: 1,
			preview:
				"--- a/a.ts\n+++ b/a.ts\n@@ -120,1 +120,2 @@\n-old\n+new\n+extra\n@@ -200,1 +201,1 @@\n keep\n\\ No newline at end of file\n",
		});
		expect(
			lines.map(({ oldNumber, newNumber }) => [oldNumber, newNumber]),
		).toEqual([
			[120, null],
			[null, 120],
			[null, 121],
			[200, 201],
		]);
	});
	it("does not display malformed patches with made-up source numbers", () => {
		expect(
			diffPreviewLines({
				path: "a.ts",
				change: "update",
				additions: 0,
				deletions: 0,
				preview: "@@ -120,5 +120,5 @@\n-one\n",
			}),
		).toEqual([]);
	});
	it("preserves content that resembles a patch header inside a hunk", () => {
		const lines = diffPreviewLines({
			path: "a.txt",
			change: "update",
			additions: 1,
			deletions: 1,
			preview: "@@ -1 +1 @@\n--- old content\n+++ new content\n",
		});
		expect(lines.map((line) => line.text)).toEqual([
			"-- old content",
			"++ new content",
		]);
	});
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
			{ kind: "add", text: "print(1)", oldNumber: null, newNumber: 1 },
			{ kind: "add", text: "print(2)", oldNumber: null, newNumber: 2 },
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
			{ kind: "ctx", text: "keep", oldNumber: 1, newNumber: 1 },
			{ kind: "del", text: "old", oldNumber: 2, newNumber: null },
			{ kind: "add", text: "new", oldNumber: null, newNumber: 2 },
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
