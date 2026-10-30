import { expect, it } from "vitest";
import {
	fileReferenceLabel,
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
