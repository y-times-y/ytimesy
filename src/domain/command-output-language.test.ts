import { expect, it } from "vitest";
import {
	changedWords,
	commandOutputLanguage,
	diffOutputFiles,
	editDiffLines,
	patchDiffFiles,
} from "./command-output-language";

it("colours a command that prints one file as that file's language", () => {
	expect(commandOutputLanguage("cat src/server/services/archive.ts")).toBe(
		"typescript",
	);
	expect(commandOutputLanguage("sed -n '1,80p' app/models.py")).toBe("python");
	expect(commandOutputLanguage("head -40 README.md")).toBe("markdown");
	expect(commandOutputLanguage("tail -n 20 config.yml")).toBe("yaml");
	expect(commandOutputLanguage("nl -ba src/a.tsx | sed -n '10,40p'")).toBe(
		"tsx",
	);
	expect(commandOutputLanguage("cd /repo && cat package.json")).toBe("json");
	expect(commandOutputLanguage("/bin/bash -lc 'cat src/main.rs'")).toBe("rust");
});

it("colours diffs", () => {
	expect(commandOutputLanguage("git diff")).toBe("diff");
	expect(commandOutputLanguage("git diff --stat")).toBe("text");
	expect(commandOutputLanguage("git show HEAD -- src/a.ts")).toBe("diff");
	expect(commandOutputLanguage("git diff | head -200")).toBe("diff");
});

it("leaves mixed or unknown output plain", () => {
	expect(commandOutputLanguage("cat a.ts b.ts")).toBe("text");
	expect(commandOutputLanguage("cat a.ts && pnpm test")).toBe("text");
	expect(commandOutputLanguage("cat a.ts | grep foo")).toBe("text");
	expect(commandOutputLanguage("cat notes")).toBe("text");
	expect(commandOutputLanguage("pnpm test")).toBe("text");
	expect(commandOutputLanguage("rg -n archive src")).toBe("text");
});

it("splits diff output per file: path, language, counts and numbered lines", () => {
	const files = diffOutputFiles(
		[
			"diff --git a/src/a.ts b/src/a.ts",
			"index 1..2 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,2 +1,2 @@",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			"@@ -40,1 +40,2 @@ function f() {",
			" x();",
			"+y();",
			"diff --git a/app.py b/app.py",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/app.py",
			"@@ -0,0 +1 @@",
			"+print('hi')",
			"",
		].join("\n"),
	);
	expect(
		files.map(({ path, language, added, removed }) => [
			path,
			language,
			added,
			removed,
		]),
	).toEqual([
		["src/a.ts", "typescript", 2, 1],
		["app.py", "python", 1, 0],
	]);
	expect(
		files[0]?.lines.map((line) => [line.kind, line.number ?? null, line.code]),
	).toEqual([
		["context", 1, "const a = 1;"],
		["removed", 2, "const b = 2;"],
		["added", 2, "const b = 3;"],
		["break", null, ""],
		["context", 40, "x();"],
		["added", 41, "y();"],
	]);
	expect(files[1]?.lines).toEqual([
		{ kind: "added", code: "print('hi')", number: 1 },
	]);
});

it("keeps git show's commit header as plain lines before the files", () => {
	const [header, file] = diffOutputFiles(
		"commit abc\nAuthor: A\n\n    Fix it\n\ndiff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b",
	);
	expect(header?.path).toBeNull();
	expect(header?.lines.map((line) => line.code)).toEqual([
		"commit abc",
		"Author: A",
		"",
		"    Fix it",
		"",
	]);
	expect(file?.path).toBe("x.ts");
});

it("marks the words that changed inside an edited line", () => {
	expect(changedWords("\tconst limit = 10;", "\tconst limit = 20;")).toEqual([
		[15, 17],
		[15, 17],
	]);
	expect(changedWords("return true;", "return row.rowCount > 0;")).toEqual(
		null,
	);
	expect(changedWords("a", "a")).toBeNull();
	const [file] = diffOutputFiles(
		"diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n-const limit = 10;\n+const limit = 20;\n+log();",
	);
	// One removed line, two added: the first pair is compared.
	expect(file?.lines.map((line) => line.changed ?? null)).toEqual([
		[14, 16],
		[14, 16],
		null,
	]);
});

it("turns an edit's hunks into diff lines with the changed words marked", () => {
	expect(
		editDiffLines([
			{ removed: "const limit = 10;\n", added: "const limit = 20;\nlog();\n" },
			{ removed: "a", added: "b" },
		]).map((line) => [line.kind, line.code, line.changed ?? null]),
	).toEqual([
		["removed", "const limit = 10;", [14, 16]],
		["added", "const limit = 20;", [14, 16]],
		["added", "log();", null],
		["break", "", null],
		["removed", "a", null],
		["added", "b", null],
	]);
	expect(
		editDiffLines([
			{ removed: "const limit = 10;", added: "const limit = 20;" },
		])[1]?.changed,
	).toEqual([14, 16]);
});

it("reads apply_patch's format into files", () => {
	const [file] = patchDiffFiles(
		"*** Begin Patch\n*** Update File: src/a.ts\n@@ function f() {\n x();\n-const limit = 10;\n+const limit = 20;\n*** End Patch",
	);
	expect(file?.path).toBe("src/a.ts");
	expect(file?.language).toBe("typescript");
	expect([file?.added, file?.removed]).toEqual([1, 1]);
	expect(file?.lines.map((line) => [line.kind, line.code])).toEqual([
		["context", "x();"],
		["removed", "const limit = 10;"],
		["added", "const limit = 20;"],
	]);
	expect(file?.lines[2]?.changed).toEqual([14, 16]);
});
