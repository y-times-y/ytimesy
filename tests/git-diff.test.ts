import { expect, it } from "vitest";
import { parseGitDiffChanges } from "../src/domain/git-diff";

const output = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 export {};
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3333333..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/logo.png differ
diff --git a/notes.md b/notes.md
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/notes.md
@@ -0,0 +1,2 @@
+# Notes
+hello
`;

it("splits git diff output into per-file changes with their own patches", () => {
	const changes = parseGitDiffChanges(output);
	expect(
		changes.map(({ path, change, additions, deletions }) => ({
			path,
			change,
			additions,
			deletions,
		})),
	).toEqual([
		{ path: "src/app.ts", change: "update", additions: 1, deletions: 1 },
		{ path: "old.txt", change: "delete", additions: 0, deletions: 1 },
		{ path: "logo.png", change: "add", additions: 0, deletions: 0 },
		{ path: "notes.md", change: "add", additions: 2, deletions: 0 },
	]);
	expect(changes[0].preview).toContain("+const b = 3;");
	expect(changes[0].preview).not.toContain("old.txt");
	expect(changes[2].preview).toBeNull();
});

it("prefixes paths for additional repositories", () => {
	expect(parseGitDiffChanges(output, "api/")[0].path).toBe("api/src/app.ts");
});
