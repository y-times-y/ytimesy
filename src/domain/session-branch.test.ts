import { describe, expect, it } from "vitest";
import {
	isGeneratedSessionBranch,
	sessionBranchChangeRestartsWorkspace,
	sessionBranchName,
	sessionCloneBranch,
	sessionWorkingBranch,
} from "./session-branch";

describe("session working branch", () => {
	it("names a new chat with a description and stable id suffix", () => {
		expect(sessionBranchName({ title: "Add README", id: "a1b2c3d4" })).toBe(
			"ytimesy/add-readme-c3d4",
		);
		expect(
			sessionWorkingBranch({
				selectedBranch: "main",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("ytimesy/ytimesy-000b");
		expect(
			sessionCloneBranch({
				selectedBranch: "main",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("main");
		expect(isGeneratedSessionBranch("ytimesy")).toBe(true);
		expect(isGeneratedSessionBranch("ytimesy/add-readme-c3d4")).toBe(true);
		expect(isGeneratedSessionBranch("main")).toBe(false);
	});

	it.each([
		[
			"Improve authentication refresh handling across cloud machines",
			"improve-authentication",
		],
		["abcdefghijklmnopqrstuvwx more words", "abcdefghijklmnopqrstuvwx"],
		["a".repeat(200), "a".repeat(24)],
		[`Fix parser!!! ${"more ".repeat(100)}`, "fix-parser-more-more"],
		["🔥 中文 !!!", "workspace"],
	])("bounds long or unsupported prompt text: %s", (title, slug) => {
		const branch = sessionBranchName({ title, id: "a1b2c3d4" });
		expect(branch).toBe(`ytimesy/${slug}-c3d4`);
		expect(branch.length).toBeLessThanOrEqual(37);
		expect(branch).not.toContain("--");
	});

	it("preserves an existing long branch when continuing a chat", () => {
		const stored = `ytimesy/${"long-description-".repeat(5)}abcd`;
		expect(
			sessionWorkingBranch({
				selectedBranch: stored,
				title: "New prompt",
				id: "11",
			}),
		).toBe(stored);
	});

	it("keeps a stored ytimesy/ branch and remaps the old bare ytimesy sentinel", () => {
		expect(
			sessionWorkingBranch({
				selectedBranch: "ytimesy/add-readme-c3d4",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("ytimesy/add-readme-c3d4");
		expect(
			sessionWorkingBranch({
				selectedBranch: "ytimesy",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("ytimesy/ytimesy-000b");
		expect(
			sessionCloneBranch({
				selectedBranch: "ytimesy",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("main");
	});

	it("keeps an existing non-default branch when the user continues there", () => {
		expect(
			sessionWorkingBranch({
				selectedBranch: "feature",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("feature");
		expect(
			sessionCloneBranch({
				selectedBranch: "feature",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("feature");
	});

	it("clones the remote default when the generated branch is not on GitHub yet", () => {
		expect(
			sessionCloneBranch({
				selectedBranch: "ytimesy",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("");
	});

	it("does not remake the workspace when main and the generated branch are the same checkout", () => {
		expect(
			sessionBranchChangeRestartsWorkspace({
				from: "main",
				to: "ytimesy",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe(false);
		expect(
			sessionBranchChangeRestartsWorkspace({
				from: "main",
				to: "feature",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe(true);
	});
});
