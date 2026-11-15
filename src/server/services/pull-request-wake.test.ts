import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { wakeMessageId } from "#/domain/pull-request-wake";
import {
	deliverPullRequestWakes,
	startPullRequestFix,
} from "./pull-request-wake";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	finish: vi.fn(),
	bind: vi.fn(),
	linkForOwner: vi.fn(),
	session: vi.fn(),
	sessions: vi.fn(),
	saveBranch: vi.fn(),
	open: vi.fn(),
	send: vi.fn(),
	consume: vi.fn(),
	github: {
		pull: vi.fn(),
		comment: vi.fn(),
		canWrite: vi.fn(),
		failingChecks: vi.fn(),
		reply: vi.fn(),
	},
}));
vi.mock("../adapters/pull-request-links", () => ({
	claimPullRequestWake: mocks.claim,
	finishPullRequestWake: mocks.finish,
	bindPullRequestLinkSession: mocks.bind,
	pullRequestLinkForOwner: mocks.linkForOwner,
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: mocks.session,
	listAgentSessions: mocks.sessions,
	saveSessionWorkingBranch: mocks.saveBranch,
}));
vi.mock("../adapters/github/pull-request-wake-github", () => ({
	pullRequestWakeGitHub: async () => mocks.github,
}));
vi.mock("../adapters/user-action-rate", () => ({
	consumeUserAction: mocks.consume,
}));
vi.mock("./agent-session-machine", () => ({ openAgentSession: mocks.open }));
vi.mock("./queued-user-messages", () => ({ sendComposerMessage: mocks.send }));

const machines = {} as WorkspaceMachines;
const sha = "a".repeat(40);
const link = {
	id: "link",
	userId: "alice",
	projectId: "project",
	installationId: "2",
	repositoryId: "1",
	fullName: "owner/app",
	pullNumber: 12,
	headRef: "ytimesy/fix-ab12",
	baseRef: "main",
	originSessionId: null as string | null,
	sessionId: null as string | null,
};
const chat = (overrides: Record<string, unknown> = {}) => ({
	id: "chat",
	userId: "alice",
	projectId: "project",
	parentSessionId: null,
	harness: "api",
	listedModelId: "conn|model",
	workingBranch: "ytimesy/fix-ab12",
	...overrides,
});
let queue: unknown[] = [];

beforeEach(() => {
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "1");
	vi.stubEnv("APP_URL", "https://app.example");
	queue = [
		{
			link,
			dedupeKey: "comment:99",
			deliveryId: "d1",
			kind: "comment",
			sourceId: 99,
			headSha: null,
			failures: 0,
		},
	];
	mocks.claim.mockImplementation(async () => queue.shift() ?? null);
	mocks.github.pull.mockResolvedValue({
		fullName: "owner/app",
		number: 12,
		title: "Fix parser",
		url: "https://github.com/owner/app/pull/12",
		headRef: "ytimesy/fix-ab12",
		baseRef: "main",
		headSha: sha,
		open: true,
		sameRepository: true,
		baseRepositoryId: 1,
	});
	mocks.github.comment.mockResolvedValue({
		author: "alice-gh",
		instruction: "rename the flag",
		url: "https://github.com/owner/app/pull/12#issuecomment-99",
	});
	mocks.github.canWrite.mockResolvedValue(true);
	mocks.github.failingChecks.mockResolvedValue([]);
	mocks.github.reply.mockResolvedValue(undefined);
	mocks.session.mockResolvedValue(null);
	mocks.sessions.mockResolvedValue([chat({ id: "other", workingBranch: "x" })]);
	mocks.open.mockResolvedValue(chat({ id: "new", workingBranch: null }));
	mocks.saveBranch.mockImplementation(async (_user, id, branch) =>
		chat({ id, workingBranch: branch }),
	);
	mocks.send.mockReturnValue(
		Effect.succeed({ connection: { status: "connected" } }),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
});

it("starts a new chat on the pull request's branch for a collaborator's @ytimesy comment", async () => {
	await deliverPullRequestWakes(machines);
	expect(mocks.github.canWrite).toHaveBeenCalledWith("alice-gh");
	expect(mocks.open).toHaveBeenCalledWith({
		userId: "alice",
		projectId: "project",
		harness: "api",
		title: "Fix PR #12",
	});
	expect(mocks.saveBranch).toHaveBeenCalledWith(
		"alice",
		"new",
		"ytimesy/fix-ab12",
		"main",
	);
	expect(mocks.bind).toHaveBeenCalledWith("link", "new");
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ sessionId: "new", harnessId: "api" }),
		expect.objectContaining({
			modelId: "conn|model",
			idempotencyKey: wakeMessageId("link:comment:99"),
			text: expect.stringContaining(
				"@alice-gh asked on GitHub:\nrename the flag",
			),
		}),
	);
	expect(mocks.finish).toHaveBeenCalledWith(queue[0] ?? expect.anything(), {
		status: "delivered",
		sessionId: "new",
	});
	expect(mocks.github.reply).toHaveBeenCalledWith(
		expect.stringContaining("https://app.example/?project=project&chat=new"),
	);
});

it("continues the chat already bound to the pull request", async () => {
	queue = [{ ...(queue[0] as object), link: { ...link, sessionId: "chat" } }];
	mocks.session.mockResolvedValue(chat());
	await deliverPullRequestWakes(machines);
	expect(mocks.open).not.toHaveBeenCalled();
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ sessionId: "chat" }),
		expect.anything(),
	);
});

it("ignores comments from people without write access", async () => {
	mocks.github.canWrite.mockResolvedValue(false);
	await deliverPullRequestWakes(machines);
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.finish).toHaveBeenCalledWith(expect.anything(), {
		status: "ignored",
		reason: "Only collaborators with write access can direct ytimesy.",
	});
});

it("ignores a pull request that moved to a fork or another branch", async () => {
	mocks.github.pull.mockResolvedValue({
		...(await mocks.github.pull()),
		sameRepository: false,
	});
	await deliverPullRequestWakes(machines);
	expect(mocks.github.comment).not.toHaveBeenCalled();
	expect(mocks.finish).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ status: "ignored" }),
	);
});

it("wakes for CI only while the failed commit is still the head and still failing", async () => {
	const ci = {
		link,
		dedupeKey: `ci:${sha}`,
		deliveryId: "d2",
		kind: "ci",
		sourceId: 5,
		headSha: sha,
		failures: 0,
	};
	queue = [{ ...ci, headSha: "b".repeat(40) }, ci, ci];
	mocks.github.failingChecks
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([
			{ name: "test", conclusion: "failure", annotations: [] },
		]);
	await deliverPullRequestWakes(machines);
	expect(mocks.finish.mock.calls.map((call) => call[1])).toEqual([
		{ status: "ignored", reason: "A newer commit replaced the failed one." },
		{ status: "ignored", reason: "No check is failing on the current head." },
		{ status: "delivered", sessionId: "new" },
	]);
	expect(mocks.send.mock.calls[0]?.[2].text).toContain(
		"CI failed on this pull request",
	);
	expect(mocks.github.reply).not.toHaveBeenCalled();
});

it("blocks without a model and retries GitHub or send failures", async () => {
	mocks.open.mockResolvedValue(chat({ id: "new", listedModelId: null }));
	mocks.saveBranch.mockResolvedValue(chat({ id: "new", listedModelId: null }));
	await deliverPullRequestWakes(machines);
	expect(mocks.finish).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({ status: "blocked" }),
	);
	queue = [{ link, dedupeKey: "comment:1", kind: "comment", sourceId: 1 }];
	mocks.github.pull.mockRejectedValue(new Error("502"));
	await deliverPullRequestWakes(machines);
	expect(mocks.finish).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({ status: "retry" }),
	);
});

it("does nothing while PR repair is off", async () => {
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "0");
	await deliverPullRequestWakes(machines);
	expect(mocks.claim).not.toHaveBeenCalled();
});

it("starts the Fix with ytimesy chat for the owner only, with the failing checks", async () => {
	mocks.linkForOwner.mockResolvedValueOnce(null);
	await expect(
		startPullRequestFix(machines, {
			userId: "bob",
			projectId: "project",
			linkId: "link",
			requestId: "r1",
		}),
	).rejects.toMatchObject({ status: 404 });
	mocks.linkForOwner.mockResolvedValue(link);
	mocks.github.failingChecks.mockResolvedValue([
		{ name: "lint", conclusion: "failure", annotations: [] },
	]);
	await expect(
		startPullRequestFix(machines, {
			userId: "alice",
			projectId: "project",
			linkId: "link",
			requestId: "r1",
			note: "Also update the docs",
		}),
	).resolves.toEqual({ sessionId: "new" });
	const sent = mocks.send.mock.calls[0]?.[2];
	expect(sent.idempotencyKey).toBe(wakeMessageId("fix:link:r1"));
	expect(sent.text.startsWith("Also update the docs")).toBe(true);
	expect(sent.text).toContain("### lint (failure)");
	mocks.github.pull.mockResolvedValue({
		...(await mocks.github.pull()),
		open: false,
	});
	await expect(
		startPullRequestFix(machines, {
			userId: "alice",
			projectId: "project",
			linkId: "link",
			requestId: "r2",
		}),
	).rejects.toMatchObject({ status: 409 });
});
