import { describe, expect, it } from "vitest";
import {
	fileEditorSaveHotkey,
	fileEditorSaveShortcut,
	parseWorkspaceExplorerListing,
	workspaceSourcePath,
	workspaceSourceText,
	workspaceSourceWriteText,
} from "./workspace-explorer";

describe("workspace explorer", () => {
	it("reads git ls-files under the checkout root", () => {
		expect(
			parseWorkspaceExplorerListing(
				[
					"PROJECT_CWD=/home/ubuntu/ytimesy",
					"src/styles.css",
					"src/domain/session-item.ts",
					"",
				].join("\n"),
			),
		).toEqual({
			root: "/home/ubuntu/ytimesy",
			paths: ["src/styles.css", "src/domain/session-item.ts"],
		});
	});

	it("keeps reads inside the checkout", () => {
		expect(
			workspaceSourcePath("/home/ubuntu/ytimesy", "src/styles.css"),
		).toBe("/home/ubuntu/ytimesy/src/styles.css");
		expect(
			workspaceSourcePath(
				"/home/ubuntu/ytimesy",
				"/home/ubuntu/ytimesy/src/styles.css",
			),
		).toBe("/home/ubuntu/ytimesy/src/styles.css");
		expect(workspaceSourcePath("/home/ubuntu/ytimesy", "../etc/passwd")).toBe(
			null,
		);
		expect(workspaceSourceText("export const ok = true;\n")).toBe(
			"export const ok = true;\n",
		);
		expect(workspaceSourceText("bin\0ary")).toBeNull();
		expect(workspaceSourceWriteText("const n = 120_000;\n")).toBe(
			"const n = 120_000;\n",
		);
		expect(workspaceSourceWriteText("bin\0ary")).toBeNull();
	});

	it("saves from the browser with the page-save shortcut", () => {
		expect(
			fileEditorSaveHotkey({ metaKey: true, ctrlKey: false, key: "s" }),
		).toBe(true);
		expect(
			fileEditorSaveHotkey({ metaKey: false, ctrlKey: true, key: "s" }),
		).toBe(true);
		expect(
			fileEditorSaveHotkey({ metaKey: false, ctrlKey: false, key: "s" }),
		).toBe(false);
		expect(fileEditorSaveShortcut("MacIntel")).toBe("⌘S");
		expect(fileEditorSaveShortcut("Win32")).toBe("Ctrl+S");
	});
});
