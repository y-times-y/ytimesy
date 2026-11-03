import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { MemoryWorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	ChatPublicationSkipped,
	publishCompletedSessionTurn,
	unpublishedTurnRepositories,
} from "./turn-publication";

const deps = vi.hoisted(() => ({
	project: vi.fn(),
	token: vi.fn(),
	authorize: vi.fn(),
	push: vi.fn(),
	ahead: vi.fn(),
	find: vi.fn(),
	pull: vi.fn(),
	evidence: vi.fn(),
	adopt: vi.fn(),
	evalUser: vi.fn(),
	evaluation: vi.fn(),
	branchName: vi.fn(),
	setupChat: vi.fn(),
}));
vi.mock("../adapters/environment-setup-chats", () => ({
	isEnvironmentSetupChat: deps.setupChat,
}));
vi.mock("../adapters/dev-eval-users", () => ({ isDevEvalUser: deps.evalUser }));
vi.mock("../adapters/harness-evaluation", () => ({
	evaluationRunForTask: deps.evaluation,
}));
vi.mock("./session-branch", async (original) => ({
	...(await original<typeof import("./session-branch")>()),
	availableChatBranchName: deps.branchName,
}));
vi.mock("./pr-evidence-job", () => ({
	queuePullRequestEvidence: deps.evidence,
}));
vi.mock("../adapters/projects", () => ({ projectForOwner: deps.project }));
vi.mock("../auth/github-connection", () => ({ githubAccessToken: deps.token }));
vi.mock("../adapters/github", () => ({
	authorizedRepository: deps.authorize,
	compareBranchAhead: deps.ahead,
	findOpenPullRequest: deps.find,
}));
vi.mock("../adapters/github/app-pull-request", () => ({
	ensureAppDraftPullRequest: deps.pull,
}));
vi.mock("../adapters/github/git-broker", () => ({
	pushBrokeredRepository: deps.push,
}));
vi.mock("../adapters/agent-sessions", () => ({
	adoptChatPublicationBranch: deps.adopt,
}));
const turn = "a".repeat(64);
const session = {
	id: "chat-abcd",
	userId: "alice",
	projectId: "project",
	providerRef: "chat-vm",
	parentSessionId: null,
	title: "Fix parser",
	workingBranch: "ytimesy/fix-parser-caabcd",
	baseBranch: "main",
} as AgentSessionRecord;
beforeEach(() => {
	vi.resetAllMocks();
	deps.project.mockResolvedValue({
		fullName: "owner/primary",
		repositoryId: 1,
		installationId: 2,
		branch: "main",
		repositories: [
			{
				fullName: "owner/primary",
				repositoryId: 1,
				installationId: 2,
				branch: "main",
			},
			{
				fullName: "owner/secondary",
				repositoryId: 3,
				installationId: 2,
				branch: "develop",
			},
		],
	});
	deps.token.mockResolvedValue("owner-token");
	deps.evalUser.mockResolvedValue(false);
	deps.evaluation.mockResolvedValue(null);
	deps.setupChat.mockResolvedValue(false);
	deps.evidence.mockResolvedValue(undefined);
	deps.authorize.mockResolvedValue({ defaultBranch: "main" });
	deps.ahead.mockResolvedValue(1);
	deps.find.mockResolvedValue(null);
	deps.pull.mockResolvedValue({
		url: "https://github.com/owner/primary/pull/1",
		draft: true,
	});
});
it("pushes the completed revision for each repository and returns the primary draft handoff", async () => {
	const runtime = new MemoryWorkspaceRuntime({
		exitCode: 0,
		stdout: "1\n",
		stderr: "",
	});
	const result = await publishCompletedSessionTurn(session, runtime, turn);
	expect(result).toEqual({
		branch: "ytimesy/fix-parser-caabcd",
		pullRequestUrl: "https://github.com/owner/primary/pull/1",
	});
	expect(deps.project).toHaveBeenCalledWith("alice", "project");
	expect(deps.token).toHaveBeenCalledTimes(1);
	expect(deps.push.mock.calls.map((call) => call[1].baseBranch)).toEqual([
		"main",
		"develop",
	]);
	for (const [, input] of deps.push.mock.calls) {
		expect(input.branch).toBe("ytimesy/fix-parser-caabcd");
		expect(input.revision).toBe(`refs/ytimesy/turn-commits/${turn}`);
	}
	expect(deps.pull).toHaveBeenCalledTimes(2);
	for (const call of deps.pull.mock.calls) {
		expect(call[2].body).not.toContain("Automatic draft handoff");
		expect(call[4]).toBe("owner-token");
	}
	// Each pull request is recorded as the project's, for GitHub wake-ups.
	expect(deps.pull.mock.calls.map((call) => call[3])).toEqual([
		{
			userId: "alice",
			projectId: "project",
			repositoryId: 1,
			sessionId: "chat-abcd",
		},
		{
			userId: "alice",
			projectId: "project",
			repositoryId: 3,
			sessionId: "chat-abcd",
		},
	]);
});
it("queues evidence for the primary pull request only, and a failure never fails the handoff", async () => {
	deps.pull.mockResolvedValue({
		number: 9,
		url: "https://github.com/owner/primary/pull/9",
		draft: true,
	});
	deps.evidence.mockRejectedValue(new Error("capture broke"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	await publishCompletedSessionTurn(
		session,
		new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "1\n", stderr: "" }),
		turn,
	);
	expect(deps.evidence).toHaveBeenCalledTimes(1);
	// Only a background job is queued: no capture runs inside the turn.
	expect(deps.evidence.mock.calls[0][0]).toEqual({
		userId: "alice",
		sessionId: session.id,
		revision: `refs/ytimesy/turn-commits/${turn}`,
		installationId: 2,
		fullName: "owner/primary",
		pullNumber: 9,
	});
	expect(deps.pull).toHaveBeenCalled();
	expect(warn).toHaveBeenCalledWith(
		"Pull request evidence could not be queued.",
		{
			message: "capture broke",
		},
	);
	warn.mockRestore();
});
it("does not push or request credentials for a chat without commits since its base", async () => {
	await publishCompletedSessionTurn(
		session,
		new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "0\n", stderr: "" }),
		turn,
	);
	expect(deps.token).not.toHaveBeenCalled();
	expect(deps.push).not.toHaveBeenCalled();
	expect(deps.pull).not.toHaveBeenCalled();
});
it("fails a rejected push without creating a PR or recording publication", async () => {
	deps.push.mockRejectedValue(new Error("Non-fast-forward push rejected"));
	await expect(
		publishCompletedSessionTurn(
			session,
			new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "1", stderr: "" }),
			turn,
		),
	).rejects.toThrow("Non-fast-forward");
	expect(deps.pull).not.toHaveBeenCalled();
});
it("never automatically pushes to the repository default branch", async () => {
	await expect(
		publishCompletedSessionTurn(
			{ ...session, workingBranch: "main" },
			new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "1", stderr: "" }),
			turn,
		),
	).rejects.toBeInstanceOf(ChatPublicationSkipped);
	expect(deps.push).not.toHaveBeenCalled();
});

const chat = {
	id: "chat-abcd",
	userId: "alice",
	projectId: "project",
	providerRef: "chat-vm",
	parentSessionId: null,
	taskAccess: null,
	taskPlacement: null,
	title: "Fix parser",
	workingBranch: "ytimesy/fix-parser-00abcd",
	baseBranch: "main",
} as unknown as AgentSessionRecord;
const changed = () =>
	new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "1\n", stderr: "" });

it("pushes a root chat's own branch, opens its draft PR with the Fix link origin and remembers the push", async () => {
	deps.pull.mockResolvedValue({
		number: 7,
		url: "https://github.com/owner/primary/pull/7",
		draft: true,
	});
	const runtime = changed();
	const result = await publishCompletedSessionTurn(chat, runtime, turn);
	expect(deps.push.mock.calls[0][1]).toMatchObject({
		branch: "ytimesy/fix-parser-00abcd",
		baseBranch: "main",
		revision: `refs/ytimesy/turn-commits/${turn}`,
	});
	expect(deps.pull.mock.calls[0][2]).toMatchObject({
		head: "ytimesy/fix-parser-00abcd",
		base: "main",
	});
	expect(deps.pull.mock.calls[0][2].body).toBe(
		"No description of this change was available from this turn, so none was invented.",
	);
	expect(deps.pull.mock.calls[0][2].body).not.toContain(
		"Automatic draft handoff",
	);
	expect(deps.pull.mock.calls[0][4]).toBe("owner-token");
	expect(deps.pull.mock.calls[0][3]).toEqual({
		userId: "alice",
		projectId: "project",
		repositoryId: 1,
		sessionId: "chat-abcd",
	});
	expect(deps.adopt).not.toHaveBeenCalled();
	expect(result).toEqual({
		branch: "ytimesy/fix-parser-00abcd",
		pullRequestUrl: "https://github.com/owner/primary/pull/7",
		pullRequest: {
			number: 7,
			url: "https://github.com/owner/primary/pull/7",
			draft: true,
			created: false,
		},
	});
	const commands = runtime.commands.map((command) => command.argv[2]);
	expect(commands[0]).toContain("refs/ytimesy/published");
	expect(
		commands.some((command) =>
			command.includes(
				`update-ref refs/ytimesy/published refs/ytimesy/turn-commits/${turn}`,
			),
		),
	).toBe(true);
});

it("publishes the turn's description, files, and checks instead of a generic handoff", async () => {
	await publishCompletedSessionTurn(chat, changed(), turn, {
		description:
			"The parser rejects an empty token and reports the line number, so invalid input fails at the source.",
		finalAnswer: null,
		files: ["src/parser.ts"],
		verification: [{ command: "pnpm test", exitCode: 0 }],
	});
	const body = deps.pull.mock.calls[0][2].body as string;
	expect(body).toContain("rejects an empty token");
	expect(body).toContain("`src/parser.ts`");
	expect(body).toContain("`pnpm test` (exit 0)");
	// The mention and "Generated with ytimesy" are the footer's job
	// (ensureAppDraftPullRequest); @ytimesy is an unrelated GitHub user.
	expect(body).not.toContain("@ytimesy");
	expect(body).not.toContain("Automatic draft handoff");
	expect(deps.pull.mock.calls[0][4]).toBe("owner-token");
});

it("pushes nothing for a chat turn whose revision was already pushed or changed nothing", async () => {
	await publishCompletedSessionTurn(
		chat,
		new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "0\n", stderr: "" }),
		turn,
	);
	expect(deps.token).not.toHaveBeenCalled();
	expect(deps.push).not.toHaveBeenCalled();
	expect(deps.pull).not.toHaveBeenCalled();
});

it("gives a chat without a branch its own short branch once and moves its checkout onto it", async () => {
	deps.branchName.mockResolvedValue("ytimesy/fix-parser-00abcd");
	deps.adopt.mockResolvedValue({
		...chat,
		workingBranch: "ytimesy/fix-parser-00abcd",
		baseBranch: "main",
	});
	const runtime = changed();
	await publishCompletedSessionTurn(
		{ ...chat, workingBranch: null, baseBranch: null },
		runtime,
		turn,
	);
	expect(deps.branchName).toHaveBeenCalledTimes(1);
	expect(deps.branchName.mock.calls[0][0]).toMatchObject({
		sessionId: "chat-abcd",
		title: "Fix parser",
	});
	expect(deps.adopt).toHaveBeenCalledWith(
		"alice",
		"chat-abcd",
		"ytimesy/fix-parser-00abcd",
		"main",
	);
	expect(
		runtime.commands.some((command) =>
			command.argv[2].includes("checkout -B 'ytimesy/fix-parser-00abcd'"),
		),
	).toBe(true);
	for (const [, input] of deps.push.mock.calls)
		expect(input.branch).toBe("ytimesy/fix-parser-00abcd");
});

it("never pushes a chat that works directly on its base or the default branch", async () => {
	await expect(
		publishCompletedSessionTurn(
			{ ...chat, workingBranch: "main" },
			changed(),
			turn,
		),
	).rejects.toBeInstanceOf(ChatPublicationSkipped);
	expect(deps.push).not.toHaveBeenCalled();
	expect(deps.pull).not.toHaveBeenCalled();
});

it.each([
	["a dev eval user", () => deps.evalUser.mockResolvedValue(true)],
	[
		"an evaluation run",
		() => deps.evaluation.mockResolvedValue({ id: "evaluation" }),
	],
	["an environment-setup chat", () => deps.setupChat.mockResolvedValue(true)],
])("never pushes for %s", async (_label, arrange) => {
	arrange();
	for (const each of [chat, session]) {
		const runtime = changed();
		await expect(
			publishCompletedSessionTurn(each, runtime, turn),
		).resolves.toBeUndefined();
		expect(runtime.commands).toHaveLength(0);
	}
	expect(deps.project).not.toHaveBeenCalled();
	expect(deps.token).not.toHaveBeenCalled();
	expect(deps.push).not.toHaveBeenCalled();
});

it("never publishes a subagent, writer or reader", async () => {
	for (const agentRole of ["writer", "researcher"])
		await publishCompletedSessionTurn(
			{
				...chat,
				parentSessionId: "chat-abcd",
				agentRole,
			} as AgentSessionRecord,
			changed(),
			turn,
		);
	expect(deps.evalUser).not.toHaveBeenCalled();
	expect(deps.push).not.toHaveBeenCalled();
});

it("looks up the open pull request beside the push and hands that lookup to the pull request", async () => {
	let finishPush = () => {};
	deps.push.mockReturnValue(
		new Promise<void>((resolve) => {
			finishPush = resolve;
		}),
	);
	const found = {
		number: 7,
		url: "https://github.com/owner/primary/pull/7",
		draft: true,
		body: "",
	};
	deps.find.mockResolvedValue(found);
	deps.pull.mockResolvedValue({
		number: 7,
		url: found.url,
		draft: true,
		created: false,
	});
	const publishing = publishCompletedSessionTurn(
		chat,
		changed(),
		turn,
		undefined,
		new Set(["owner/primary"]),
	);
	await vi.waitFor(() => expect(deps.push).toHaveBeenCalledTimes(1));
	// Asked while the push is still running.
	expect(deps.find).toHaveBeenCalledWith("owner-token", "owner/primary", {
		head: "ytimesy/fix-parser-00abcd",
		base: "main",
	});
	expect(deps.ahead).not.toHaveBeenCalled();
	finishPush();
	const result = await publishing;
	await expect(deps.pull.mock.calls[0][5]).resolves.toBe(found);
	// Only the repository with commits to push was published.
	expect(deps.push).toHaveBeenCalledTimes(1);
	expect(result?.pullRequest).toEqual({
		number: 7,
		url: found.url,
		draft: true,
		created: false,
	});
});

it("lists the repositories whose checkout holds the turn's unpublished commits", async () => {
	const commands: string[] = [];
	const runtime = {
		exec: async (_ref: string, argv: string[]) => {
			commands.push(argv[2] ?? "");
			return {
				exitCode: 0,
				stdout: argv[2]?.includes("secondary") ? "0\n" : "2\n",
				stderr: "",
			};
		},
	};
	const pending = await unpublishedTurnRepositories(
		runtime,
		"chat-vm",
		[{ fullName: "owner/primary" }, { fullName: "owner/secondary" }],
		turn,
	);
	expect([...pending]).toEqual(["owner/primary"]);
	expect(commands).toHaveLength(2);
});
