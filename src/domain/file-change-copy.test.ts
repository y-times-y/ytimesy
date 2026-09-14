import { describe, expect, it } from "vitest";
import {
	fileChangeActivityTitle,
	fileChangesHeading,
	filesChangedLabel,
} from "./file-change-copy";
import type { FileChangeEntry } from "./session-item";

const todoPy: FileChangeEntry = {
	path: "/home/ubuntu/todo-cli/todo.py",
	change: "add",
	additions: 88,
	deletions: 0,
	preview: "print(1)\n",
};

const readme: FileChangeEntry = {
	path: "README.md",
	change: "update",
	additions: 16,
	deletions: 6,
	preview: null,
};

describe("fileChangeActivityTitle", () => {
	it("names a single add, delete, or edit the way Codex activity rows do", () => {
		expect(fileChangeActivityTitle([todoPy])).toBe("Created todo.py");
		expect(fileChangeActivityTitle([{ ...todoPy, change: "delete" }])).toBe(
			"Deleted todo.py",
		);
		expect(fileChangeActivityTitle([readme])).toBe("Edited README.md");
	});

	it("summarizes multiple files without listing paths", () => {
		expect(fileChangeActivityTitle([todoPy, readme])).toBe("Edited 2 files");
	});
});

describe("fileChangesHeading", () => {
	it("labels the Diff pane with file count and totals", () => {
		expect(filesChangedLabel(1)).toBe("1 file changed");
		expect(fileChangesHeading([todoPy, readme])).toEqual({
			label: "2 files changed",
			additions: 104,
			deletions: 6,
		});
	});
});
