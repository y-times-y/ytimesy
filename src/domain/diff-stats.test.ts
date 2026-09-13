import { describe, expect, it } from "vitest";
import { countDiffLineChanges, readDiffLineCounts } from "./diff-stats";

describe("countDiffLineChanges", () => {
	it("counts added and removed lines and ignores file headers", () => {
		expect(
			countDiffLineChanges(`--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+also
`),
		).toEqual({ additions: 2, deletions: 1 });
	});

	it("prefers explicit counts when the provider already sent them", () => {
		expect(readDiffLineCounts(12, 3, "+ignored\n-ignored")).toEqual({
			additions: 12,
			deletions: 3,
		});
	});
});
