import { describe, expect, it } from "vitest";
import type { FileChangeEntry } from "./session-item";
import {
	fileChangeForPath,
	fileTreeChangeMark,
	firstWorkspaceFilePath,
	workspaceExplorerTree,
	workspaceFileTree,
} from "./workspace-file-tree";

function change(
	path: string,
	kind: FileChangeEntry["change"] = "update",
): FileChangeEntry {
	return {
		path,
		change: kind,
		additions: 1,
		deletions: 0,
		preview: "+ok\n",
	};
}

describe("workspace file tree", () => {
	it("nests files under directories the way a Files inspector does", () => {
		expect(
			workspaceFileTree([
				change("src/domain/session-item.ts"),
				change("FOLLOWUP_RESUME.md", "add"),
				change("/home/ubuntu/src/domain/file-kind.ts"),
			]),
		).toEqual([
			{
				kind: "dir",
				name: "src",
				path: "src",
				children: [
					{
						kind: "dir",
						name: "domain",
						path: "src/domain",
						children: [
							{
								kind: "file",
								name: "file-kind.ts",
								path: "src/domain/file-kind.ts",
								change: change("/home/ubuntu/src/domain/file-kind.ts"),
							},
							{
								kind: "file",
								name: "session-item.ts",
								path: "src/domain/session-item.ts",
								change: change("src/domain/session-item.ts"),
							},
						],
					},
				],
			},
			{
				kind: "file",
				name: "FOLLOWUP_RESUME.md",
				path: "FOLLOWUP_RESUME.md",
				change: change("FOLLOWUP_RESUME.md", "add"),
			},
		]);
	});

	it("opens a mentioned basename when only one file matches", () => {
		const changes = [
			change("FOLLOWUP_RESUME.md", "add"),
			change("src/domain/session-item.ts"),
		];
		expect(fileChangeForPath(changes, "FOLLOWUP_RESUME.md")?.path).toBe(
			"FOLLOWUP_RESUME.md",
		);
		expect(fileChangeForPath(changes, "session-item.ts")?.path).toBe(
			"src/domain/session-item.ts",
		);
		expect(firstWorkspaceFilePath(workspaceFileTree(changes))).toBe(
			"src/domain/session-item.ts",
		);
	});

	it("lists the workspace tree and only marks files that changed", () => {
		expect(
			workspaceExplorerTree(
				["src/domain/session-item.ts", "src/styles.css"],
				[change("src/styles.css")],
			),
		).toMatchObject([
			{
				kind: "dir",
				name: "src",
				children: [
					{
						kind: "dir",
						name: "domain",
						children: [
							{
								kind: "file",
								name: "session-item.ts",
								path: "src/domain/session-item.ts",
							},
						],
					},
					{
						kind: "file",
						name: "styles.css",
						path: "src/styles.css",
						change: change("src/styles.css"),
					},
				],
			},
		]);
		expect(fileTreeChangeMark("update")).toBe("M");
		expect(fileTreeChangeMark("add")).toBe("U");
		expect(fileTreeChangeMark(undefined)).toBeNull();
	});
});
