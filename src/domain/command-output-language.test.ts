import { expect, it } from "vitest";
import {
	commandOutputLanguage,
	diffOutputFiles,
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

it("splits diff output per file with each file's language", () => {
	const files = diffOutputFiles(
		[
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,2 +1,2 @@",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			"diff --git a/app.py b/app.py",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/app.py",
			"+print('hi')",
		].join("\n"),
	);
	expect(files.map((file) => file.language)).toEqual(["typescript", "python"]);
	expect(files[0]?.lines.map((line) => [line.kind, line.code])).toEqual([
		["meta", "diff --git a/src/a.ts b/src/a.ts"],
		["meta", "--- a/src/a.ts"],
		["meta", "+++ b/src/a.ts"],
		["meta", "@@ -1,2 +1,2 @@"],
		["context", "const a = 1;"],
		["removed", "const b = 2;"],
		["added", "const b = 3;"],
	]);
});
