import { expect, it } from "vitest";
import { fileChangesFromGitPorcelain } from "./git-working-tree";

it("maps porcelain status into diff entries", () => {
	expect(
		fileChangesFromGitPorcelain(
			"?? DIFF_PROOF.md\n M src/app.ts\n D gone.ts\n",
			{
				"DIFF_PROOF.md": "ytimesy diff proof\n",
				"src/app.ts":
					"--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
			},
		),
	).toEqual([
		{
			path: "DIFF_PROOF.md",
			change: "add",
			additions: 1,
			deletions: 0,
			preview: "ytimesy diff proof\n",
		},
		{
			path: "src/app.ts",
			change: "update",
			additions: 1,
			deletions: 1,
			preview: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
		},
		{
			path: "gone.ts",
			change: "delete",
			additions: 0,
			deletions: 0,
			preview: null,
		},
	]);
});
