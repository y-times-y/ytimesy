import { describe, expect, it } from "vitest";
import {
	issueWriteAction,
	pullRequestWriteAction,
} from "./github-write-requests";

const sha = "a".repeat(40);

describe("pull request changes the API accepts", () => {
	it("accepts each change the panel sends and drops the repository fields", () => {
		const parsed = pullRequestWriteAction.parse({
			installationId: 1,
			repositoryId: 2,
			number: 3,
			action: "review",
			event: "REQUEST_CHANGES",
			body: "Please rename this.",
			headSha: sha,
			comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "Here" }],
		});
		expect(parsed).toEqual({
			action: "review",
			event: "REQUEST_CHANGES",
			body: "Please rename this.",
			headSha: sha,
			comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "Here" }],
		});
		for (const input of [
			{ action: "comment", body: "Looks good" },
			{ action: "reply", commentId: 10, body: "Done" },
			{ action: "edit-comment", kind: "inline", commentId: 10, body: "Edited" },
			{ action: "delete-comment", kind: "comment", commentId: 10 },
			{ action: "resolve-thread", threadId: "PRRT_kw", resolved: true },
			{
				action: "line-comment",
				headSha: sha,
				path: "a.ts",
				line: 1,
				side: "LEFT",
				body: "Why?",
			},
			{ action: "state", state: "closed" },
			{ action: "edit", title: "New title" },
			{ action: "reviewers", add: ["ada"], remove: [] },
			{ action: "labels", labels: ["bug"] },
			{ action: "assignees", add: [], remove: ["dependabot[bot]"] },
			{ action: "rerun", target: { jobId: 5 } },
			{ action: "rerun", target: { failedInRunId: 6 } },
		])
			expect(pullRequestWriteAction.safeParse(input).success).toBe(true);
	});

	it("refuses empty comments, bad logins and unknown changes", () => {
		for (const input of [
			{ action: "comment", body: "   " },
			{ action: "reviewers", add: ["not a login!"], remove: [] },
			{
				action: "review",
				event: "MERGE",
				body: "",
				headSha: sha,
				comments: [],
			},
			{
				action: "line-comment",
				headSha: "short",
				path: "a",
				line: 1,
				side: "RIGHT",
				body: "x",
			},
			{ action: "delete-repository" },
			{
				action: "review",
				event: "REQUEST_CHANGES",
				body: " ",
				headSha: sha,
				comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "Rename" }],
			},
		])
			expect(pullRequestWriteAction.safeParse(input).success).toBe(false);
	});
});

describe("issue changes the API accepts", () => {
	it("accepts creating, closing and commenting", () => {
		expect(
			issueWriteAction.parse({
				installationId: 1,
				repositoryId: 2,
				action: "create",
				title: " Crash on save ",
				body: "",
				labels: ["bug"],
				assignees: ["ada"],
			}),
		).toEqual({
			action: "create",
			title: "Crash on save",
			body: "",
			labels: ["bug"],
			assignees: ["ada"],
		});
		expect(
			issueWriteAction.safeParse({
				action: "state",
				number: 4,
				state: "closed",
				reason: "not_planned",
			}).success,
		).toBe(true);
		expect(
			issueWriteAction.safeParse({
				action: "comment",
				number: 4,
				body: "On it",
			}).success,
		).toBe(true);
	});

	it("refuses an issue without a title or a close reason GitHub lacks", () => {
		expect(
			issueWriteAction.safeParse({
				action: "create",
				title: "  ",
				body: "",
				labels: [],
				assignees: [],
			}).success,
		).toBe(false);
		expect(
			issueWriteAction.safeParse({
				action: "state",
				number: 4,
				state: "closed",
				reason: "duplicate-ish",
			}).success,
		).toBe(false);
	});
});
