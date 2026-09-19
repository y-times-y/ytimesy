import { describe, expect, it } from "vitest";
import {
	canSelectSessionBranch,
	isGeneratedSessionBranch,
	listedSessionBranches,
	sessionBranchChangeRestartsWorkspace,
	sessionBranchName,
	sessionCloneBranch,
	sessionWorkingBranch,
} from "./session-branch";

describe("session working branch", () => {
	it("names a new chat like Cursor: prefix/slug-id, not a bare product name", () => {
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

	it("lists the generated working branch first, never a bare ytimesy name", () => {
		expect(
			listedSessionBranches({
				remoteBranches: ["main", "feature", "ytimesy"],
				workingBranch: "ytimesy/ytimesy-000b",
			}),
		).toEqual(["ytimesy/ytimesy-000b", "main", "feature"]);
		expect(
			canSelectSessionBranch({
				branch: "ytimesy/ytimesy-000b",
				remoteBranches: ["main"],
			}),
		).toBe(true);
		expect(
			canSelectSessionBranch({ branch: "missing", remoteBranches: ["main"] }),
		).toBe(false);
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
