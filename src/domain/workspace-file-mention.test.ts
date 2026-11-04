import { expect, it } from "vitest";
import {
	fileReferenceLabel,
	sharedFileNames,
	workspaceFileMention,
	workspaceFileReference,
} from "./workspace-file-mention";

it("distinguishes workspace paths from external URLs and fragments", () => {
	for (const path of [
		"src/main.ts",
		"/workspace/src/main.ts",
		"README.md",
		"src/",
	])
		expect(workspaceFileMention(path)).toBe(path);
	for (const url of [
		"https://example.com/a.ts",
		"//example.com/a.ts",
		"javascript:alert(1)",
		"#heading",
		"plain text",
	])
		expect(workspaceFileMention(url)).toBeNull();
});

it("links only what is plausibly a file or an explicit folder, never a branch, repo, code or domain", () => {
	for (const path of [
		"src/main.ts",
		"package.json",
		"src/styles.css",
		"scripts/deploy.sh",
		"supabase/migrations/20261104_x.sql",
		"Dockerfile",
		".gitignore",
		".env.example",
		"src/server/",
		"./src/a.ts",
	])
		expect(workspaceFileMention(path)).toBe(path);
	for (const text of [
		"origin/main",
		"refs/heads/main",
		"ytimesy/hi-58de94",
		"y-times-y/ytimesy",
		"owner/repo",
		"src/server",
		"process.env",
		"Date.now",
		"console.log",
		"ytimesy.com",
		"api.ytimesy.com",
		"Node.js",
		"Next.js",
		"e.g.",
	])
		expect(workspaceFileMention(text)).toBeNull();
});

it("opens the file a line reference names, and labels it short", () => {
	for (const [text, path, lines] of [
		[
			"src/server/edge/executor.ts:510–525",
			"src/server/edge/executor.ts",
			"510–525",
		],
		["src/a.ts:12-34", "src/a.ts", "12–34"],
		["src/a.ts:12", "src/a.ts", "12"],
		["src/a.ts:12:5", "src/a.ts", "12"],
		["src/a.ts#L3-L9", "src/a.ts", "3–9"],
		["src/a.ts", "src/a.ts", null],
	] as const) {
		const reference = workspaceFileReference(text);
		expect(reference).toEqual({ path, lines });
		expect(workspaceFileMention(text)).toBe(path);
	}
	expect(
		fileReferenceLabel({
			path: "src/server/edge/executor.ts",
			lines: "510–525",
		}),
	).toBe("executor.ts:510–525");
	expect(fileReferenceLabel({ path: "src/", lines: null })).toBe("src");
});

it("keeps the folder when two files in one answer share a name", () => {
	const shared = sharedFileNames(
		"| `src/server/services/archive.ts` | x |\n| `src/server/adapters/archive.ts:4` | y |\n`src/a.ts` and [a](./src/a.ts)",
	);
	expect([...shared]).toEqual(["archive.ts"]);
	expect(
		fileReferenceLabel(
			{ path: "src/server/adapters/archive.ts", lines: "4" },
			shared,
		),
	).toBe("adapters/archive.ts:4");
	expect(fileReferenceLabel({ path: "src/a.ts", lines: null }, shared)).toBe(
		"a.ts",
	);
});
