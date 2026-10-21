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
			"ytimesy/add-readme-b2c3d4",
		);
		expect(
			sessionWorkingBranch({
				selectedBranch: "main",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("ytimesy/ytimesy-00000b");
		expect(
			sessionCloneBranch({
				selectedBranch: "main",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("main");
		expect(isGeneratedSessionBranch("ytimesy")).toBe(true);
		expect(isGeneratedSessionBranch("ytimesy/add-readme-b2c3d4")).toBe(true);
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
		["🔥 中文 !!!", "chat"],
	])("bounds long or unsupported prompt text: %s", (title, slug) => {
		const branch = sessionBranchName({ title, id: "a1b2c3d4" });
		expect(branch).toBe(`ytimesy/${slug}-b2c3d4`);
		expect(branch.length).toBeLessThanOrEqual(40);
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
				selectedBranch: "ytimesy/add-readme-b2c3d4",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("ytimesy/add-readme-b2c3d4");
		expect(
			sessionWorkingBranch({
				selectedBranch: "ytimesy",
				defaultBranch: "main",
				title: "ytimesy",
				id: "11",
			}),
		).toBe("ytimesy/ytimesy-00000b");
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

describe("chat branch names", () => {
	const uuid = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";

	it("uses six lowercase hex characters of a uuid chat id", () => {
		expect(sessionBranchName({ title: "Add README", id: uuid })).toBe(
			"ytimesy/add-readme-4d5e6f",
		);
	});

	it.each([
		["Fix   the --- Login___Bug!!", "fix-the-login-bug"],
		["  -Leading and trailing-  ", "leading-and-trailing"],
		["UPPER case Ünïcödé text", "upper-case-n-c-d-text"],
		["", "chat"],
		["!!!", "chat"],
		["supercalifragilisticexpialidocious word", "supercalifragilisticexpi"],
	])("sanitizes %j to %s", (title, slug) => {
		const branch = sessionBranchName({ title, id: uuid });
		expect(branch).toBe(`ytimesy/${slug}-4d5e6f`);
		expect(branch).toMatch(/^ytimesy\/[a-z0-9]+(-[a-z0-9]+)*$/);
	});

	it("stays within 40 characters, cut at a word boundary, collision suffix included", () => {
		const title =
			"Refactor the authentication middleware for multi tenant sessions";
		for (let attempt = 0; attempt < 6; attempt++) {
			const branch = sessionBranchName({ title, id: uuid, attempt });
			expect(branch.length).toBeLessThanOrEqual(40);
			expect(branch).not.toMatch(/--|-$/);
			expect(branch.startsWith("ytimesy/refactor-the-")).toBe(true);
		}
		expect(sessionBranchName({ title, id: uuid })).toBe(
			"ytimesy/refactor-the-4d5e6f",
		);
		const long = "abcdefghijklmnopqrstuvwx yz";
		expect(sessionBranchName({ title: long, id: uuid })).toBe(
			"ytimesy/abcdefghijklmnopqrstuvwx-4d5e6f",
		);
		const suffixed = sessionBranchName({ title: long, id: uuid, attempt: 1 });
		expect(suffixed).toBe("ytimesy/abcdefghijklmnopqrstuvw-4d5e6f-2");
		expect(suffixed).toHaveLength(40);
	});

	it("names the same chat the same way every time", () => {
		expect(sessionBranchName({ title: "Ship it", id: uuid })).toBe(
			sessionBranchName({ title: "Ship it", id: uuid }),
		);
	});
});
