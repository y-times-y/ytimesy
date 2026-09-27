import { expect, it } from "vitest";
import { workspaceFileMention } from "./workspace-file-mention";

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
