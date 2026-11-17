import { describe, expect, it } from "vitest";
import { workspacePublicationBranch } from "./publication";
import type { RepositoryPullRequest } from "./sidebar-pr";
import {
	repositoryShortName,
	runningForText,
	type YOverviewThread,
	yOverview,
} from "./y-overview";

const pr = (
	overrides: Partial<RepositoryPullRequest> = {},
): RepositoryPullRequest => ({
	number: 8357,
	url: "https://github.com/acme/web/pull/8357",
	head: "feature-a",
	base: "main",
	title: "Add billing page",
	draft: false,
	state: "open",
	merged: false,
	mergeable: true,
	mergeableState: "clean",
	additions: 120,
	deletions: 8,
	installationId: 1,
	repositoryId: 10,
	repositoryFullName: "acme/web",
	...overrides,
});

const thread = (overrides: Partial<YOverviewThread>): YOverviewThread => ({
	id: "t",
	title: "Thread",
	turnStatus: "completed",
	updatedAt: "2026-11-12T10:00:00.000Z",
	...overrides,
});

describe("yOverview", () => {
	it("groups threads waiting on the person and threads running, leaving Y² and idle ones out", () => {
		const overview = yOverview({
			chats: [
				thread({ id: "y2", title: "Y²", role: "y2", waitingOn: "question" }),
				thread({ id: "ask", title: "Ask", waitingOn: "push" }),
				thread({ id: "fail", title: "Fail", waitingOn: "failed" }),
				thread({
					id: "run",
					title: "Run",
					turnStatus: "running",
					workingSince: "2026-11-12T09:58:00.000Z",
				}),
				thread({ id: "helper", workingSince: "2026-11-12T09:59:00.000Z" }),
				thread({ id: "idle" }),
				thread({ id: "new", unused: true, waitingOn: "question" }),
			],
			pullRequests: [],
		});
		expect(overview.needsYou.map((row) => row.threadId)).toEqual([
			"ask",
			"fail",
		]);
		expect(overview.needsYou[0]?.detail).toBe("waiting on your push approval");
		expect(overview.needsYou[1]?.detail).toBe("last turn failed");
		expect(overview.inProgress.map((row) => row.threadId)).toEqual([
			"run",
			"helper",
		]);
		expect(overview.inProgress[0]?.workingSince).toBe(
			"2026-11-12T09:58:00.000Z",
		);
	});

	it("puts a running thread under In progress even with a stale wait", () => {
		const overview = yOverview({
			chats: [thread({ id: "r", turnStatus: "running", waitingOn: "plan" })],
			pullRequests: [],
		});
		expect(overview.needsYou).toEqual([]);
		expect(overview.inProgress.map((row) => row.threadId)).toEqual(["r"]);
	});

	it("lists newest activity first", () => {
		const overview = yOverview({
			chats: [
				thread({
					id: "old",
					waitingOn: "question",
					updatedAt: "2026-11-12T08:00:00.000Z",
				}),
				thread({
					id: "new",
					waitingOn: "secret",
					updatedAt: "2026-11-12T09:00:00.000Z",
				}),
			],
			pullRequests: [],
		});
		expect(overview.needsYou.map((row) => row.threadId)).toEqual([
			"new",
			"old",
		]);
	});

	it("lists open pull requests a thread's branch opened, once each, via its thread", () => {
		const workspaceId = "0f3c9a1b-2d4e-4f50-8a6b-7c8d9e0f1a2b";
		const overview = yOverview({
			chats: [
				thread({ id: "a", title: "Billing", workingBranch: "feature-a" }),
				thread({
					id: "b",
					title: "Copy of billing",
					workingBranch: "feature-a",
				}),
				thread({ id: "c", title: "Docs", workspaceId }),
				thread({ id: "d", title: "No PR", workingBranch: "nothing" }),
			],
			pullRequests: [
				pr(),
				pr({
					number: 12,
					head: `fork:${workspacePublicationBranch(workspaceId)}`,
					title: "  ",
					repositoryFullName: "acme/docs",
					draft: true,
					additions: undefined,
					deletions: undefined,
				}),
				pr({ number: 13, head: "feature-a", merged: true, state: "closed" }),
				pr({ number: 14, head: "unrelated" }),
			],
		});
		expect(overview.pullRequests).toEqual([
			expect.objectContaining({
				threadId: "a",
				threadTitle: "Billing",
				reference: "web#8357",
				title: "Add billing page",
				base: "main",
				additions: 120,
				deletions: 8,
			}),
			expect.objectContaining({
				threadId: "c",
				reference: "docs#12",
				title: `fork:${workspacePublicationBranch(workspaceId)}`,
				draft: true,
				additions: null,
				deletions: null,
			}),
		]);
	});

	it("leaves Y²'s own branch out of pull requests", () => {
		const overview = yOverview({
			chats: [thread({ id: "y2", role: "y2", workingBranch: "feature-a" })],
			pullRequests: [pr()],
		});
		expect(overview.pullRequests).toEqual([]);
	});
});

describe("runningForText", () => {
	const now = Date.parse("2026-11-12T12:00:00.000Z");
	it.each([
		[null, "running"],
		["not a date", "running"],
		["2026-11-12T11:59:30.000Z", "running"],
		["2026-11-12T11:57:00.000Z", "running 3m"],
		["2026-11-12T11:00:00.000Z", "running 1h"],
		["2026-11-12T10:55:00.000Z", "running 1h 5m"],
	])("%s reads %s", (since, text) => {
		expect(runningForText(since, now)).toBe(text);
	});
});

describe("repositoryShortName", () => {
	it("drops the owner", () => {
		expect(repositoryShortName("acme/web")).toBe("web");
		expect(repositoryShortName("web")).toBe("web");
	});
});
