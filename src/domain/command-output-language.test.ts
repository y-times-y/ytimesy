import { expect, it } from "vitest";
import { commandOutputLanguage } from "./command-output-language";

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
