import { describe, expect, it } from "vitest";
import type { FileChangeEntry } from "./session-item";
import {
	fileChangeForPath,
	fileTreeChangeMark,
	firstWorkspaceFilePath,
	workspaceExplorerTree,
	workspaceFileTree,
	workspacePathForMention,
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
	it("does not mark unrelated files sharing a basename as changed", () => {
		const tree = workspaceExplorerTree(
			["README.md", "docs/README.md"],
			[change("ytimesy/README.md")],
		);
		expect(tree[0]).toMatchObject({
			kind: "dir",
			children: [{ path: "docs/README.md" }],
		});
		if (tree[0]?.kind === "dir")
			expect(tree[0].children[0]).not.toHaveProperty("change");
		expect(tree[1]).toMatchObject({
			path: "README.md",
			change: { path: "ytimesy/README.md" },
		});
	});
	it("prefers the actual checkout path over a repository-prefixed diff path", () => {
		const changes = [change("ytimesy/README.md")];
		expect(
			workspacePathForMention("ytimesy/README.md", ["README.md"], changes),
		).toBe("README.md");
		expect(workspaceExplorerTree(["README.md"], changes)).toHaveLength(1);
		expect(workspaceExplorerTree(["README.md"], changes)[0]).toMatchObject({
			kind: "file",
			path: "README.md",
		});
	});
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

	it("resolves absolute agent links and line locations into the visible tree", () => {
		const paths = ["package.json", "src/domain/session-item.ts"];
		expect(
			workspacePathForMention(
				"/home/ubuntu/ytimesy/src/domain/session-item.ts:42",
				paths,
			),
		).toBe("src/domain/session-item.ts");
		expect(
			workspacePathForMention("/home/ubuntu/ytimesy/package.json#L9", paths),
		).toBe("package.json");
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
