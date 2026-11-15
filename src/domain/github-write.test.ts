import { describe, expect, it } from "vitest";
import {
	githubIssueFromUrl,
	issueChatMessage,
	labelTextColor,
} from "./github-issues";
import {
	actionsJobFromUrl,
	githubWriteFailure,
	loginChanges,
	logTail,
	pullRequestActionPermission,
	suggestionBlock,
} from "./github-write";
import {
	groupReviewThreads,
	type PullRequestComment,
	viewerWrote,
} from "./pull-request-review";

const person = (login: string) => ({ login, avatarUrl: null, bot: false });
const inline = (
	databaseId: number,
	inReplyTo: number | null,
	createdAt: string,
): PullRequestComment => ({
	id: `inline:${databaseId}`,
	databaseId,
	kind: "inline",
	author: person("ada"),
	body: `comment ${databaseId}`,
	createdAt,
	url: null,
	path: "src/a.ts",
	line: 3,
	inReplyTo,
});

describe("GitHub refusals", () => {
	it("names the missing GitHub App permission", () => {
		const failure = githubWriteFailure(
			{
				status: 403,
				message:
					"Resource not accessible by integration - https://docs.github.com/rest",
			},
			"Issues: write",
		);
		expect(failure?.status).toBe(403);
		expect(failure?.message).toContain('"Issues: write"');
		expect(failure?.message).toContain("approve");
	});

	it("passes GitHub's own reason for other refusals", () => {
		expect(
			githubWriteFailure(
				{
					status: 422,
					message: "Validation Failed: line must be part of the diff",
				},
				"Pull requests: write",
			),
		).toEqual({
			status: 409,
			message:
				"GitHub refused this: Validation Failed: line must be part of the diff",
		});
	});

	it("leaves server failures to the caller", () => {
		expect(
			githubWriteFailure({ status: 502 }, "Pull requests: write"),
		).toBeNull();
		expect(
			githubWriteFailure(new Error("network"), "Issues: write"),
		).toBeNull();
	});

	it("asks for Actions: write only to re-run checks", () => {
		expect(pullRequestActionPermission("rerun")).toBe("Actions: write");
		expect(pullRequestActionPermission("labels")).toBe("Pull requests: write");
	});
});

describe("review threads", () => {
	it("puts each inline reply under the comment that started its thread", () => {
		const grouped = groupReviewThreads([
			inline(1, null, "2026-11-01T00:00:00Z"),
			{
				id: "comment:9",
				databaseId: 9,
				kind: "comment",
				author: person("bob"),
				body: "general",
				createdAt: "2026-11-01T01:00:00Z",
				url: null,
			},
			inline(2, 1, "2026-11-01T02:00:00Z"),
			inline(3, 77, "2026-11-01T03:00:00Z"),
		]);
		expect(grouped.map((entry) => entry.id)).toEqual([
			"inline:1",
			"comment:9",
			"inline:3",
		]);
		expect(grouped[0].replies.map((reply) => reply.id)).toEqual(["inline:2"]);
		expect(grouped[2].replies).toEqual([]);
	});

	it("knows the viewer's own comments regardless of case", () => {
		expect(viewerWrote({ author: person("Ada") }, "ada")).toBe(true);
		expect(viewerWrote({ author: person("ada") }, null)).toBe(false);
		expect(viewerWrote({ author: person("bob") }, "ada")).toBe(false);
	});
});

describe("small GitHub helpers", () => {
	it("finds the Actions run and job behind a check", () => {
		expect(
			actionsJobFromUrl(
				"https://github.com/acme/app/actions/runs/43653065184/job/132625547662",
			),
		).toEqual({ runId: 43653065184, jobId: 132625547662 });
		expect(actionsJobFromUrl("https://ci.example.com/build/7")).toBeNull();
		expect(actionsJobFromUrl(null)).toBeNull();
	});

	it("turns picker changes into additions and removals", () => {
		expect(loginChanges(["ada", "bob"], ["Bob", "cy"])).toEqual({
			add: ["cy"],
			remove: ["ada"],
		});
	});

	it("writes a suggestion block GitHub can apply", () => {
		expect(suggestionBlock("const a = 1;")).toBe(
			"```suggestion\nconst a = 1;\n```",
		);
	});

	it("keeps a log's last lines without timestamps", () => {
		expect(
			logTail(
				"2026-11-14T10:00:00.1234Z one\n\n2026-11-14T10:00:01Z two\nthree",
				2,
			),
		).toBe("two\nthree");
	});

	it("reads an issue URL and writes the chat's first message", () => {
		expect(githubIssueFromUrl("https://github.com/acme/app/issues/42")).toEqual(
			{ fullName: "acme/app", number: 42 },
		);
		expect(
			githubIssueFromUrl("https://github.com/acme/app/pull/42"),
		).toBeNull();
		const message = issueChatMessage({
			fullName: "acme/app",
			number: 42,
			title: "  Crash   on save ",
			url: "https://github.com/acme/app/issues/42",
		});
		expect(message).toContain('issue #42 "Crash on save" in acme/app');
		expect(message).toContain("closes #42");
	});

	it("picks readable text on a label's color", () => {
		expect(labelTextColor("ffffff")).toBe("#0b0b0b");
		expect(labelTextColor("0e1a2b")).toBe("#f5f5f5");
		expect(labelTextColor("nonsense")).toBe("#f5f5f5");
	});
});
