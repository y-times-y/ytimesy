import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { MemoryWorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	answerSubject,
	commitCompletedSessionTurn,
	commitSubject,
} from "./turn-commit";

const lookup = vi.hoisted(() => vi.fn());
const evaluation = vi.hoisted(() => vi.fn());
const verification = vi.hoisted(() =>
	vi.fn(async () => ({ status: "verified", tree: "a".repeat(40) })),
);
vi.mock("./completion-verification", () => ({
	verifyCompletedRepository: verification,
}));
vi.mock("../adapters/harness-evaluation", () => ({
	evaluationRunForTask: evaluation,
}));
vi.mock("../adapters/projects", () => ({ projectForOwner: lookup }));
const branchStore = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../adapters/agent-sessions", () => ({
	saveAgentWorkingBranch: branchStore.save,
}));
const publication = vi.hoisted(() => ({
	publish: vi.fn(),
	excluded: vi.fn(async () => false),
	pending: vi.fn(
		async (_runtime: unknown, _vm: string, repos: { fullName: string }[]) =>
			new Set(repos.map((repo) => repo.fullName)),
	),
}));
const identity = vi.hoisted(() => ({
	forToken: vi.fn(),
}));
vi.mock("../auth/github-connection", () => ({
	githubAccessToken: vi.fn(async () => "user-token"),
}));
vi.mock("../adapters/github/commit-identity", () => ({
	githubCommitIdentityForToken: identity.forToken,
}));
vi.mock("./turn-publication", async (original) => ({
	ChatPublicationSkipped: (
		await original<typeof import("./turn-publication")>()
	).ChatPublicationSkipped,
	publishCompletedSessionTurn: publication.publish,
	turnPublicationExcluded: publication.excluded,
	unpublishedTurnRepositories: publication.pending,
}));

const session = {
	id: "chat-1",
	userId: "alice",
	projectId: "project-1",
	providerRef: "writer-vm",
	parentSessionId: "builder",
	title: "Fix parser",
	agentRole: "writer",
} as AgentSessionRecord;
beforeEach(() => {
	identity.forToken.mockResolvedValue({
		name: "Het",
		email: "7+het@users.noreply.github.com",
	});
});

const items: SessionItem[] = [
	{
		kind: "userMessage",
		id: SessionItemId("user-1"),
		text: "Fix parser",
		timing: { startedAt: 100 },
	},
];

it.each(["subagent", "unbound"])(
	"skips %s sessions without accessing a project or machine",
	async (kind) => {
		lookup.mockClear();
		const runtime = new MemoryWorkspaceRuntime();
		await commitCompletedSessionTurn(
			kind === "subagent"
				? session
				: { ...session, parentSessionId: null, providerRef: null },
			items,
			runtime,
		);
		expect(lookup).not.toHaveBeenCalled();
		expect(runtime.commands).toHaveLength(0);
	},
);

const chat = {
	...session,
	id: "chat-root",
	parentSessionId: null,
	agentRole: null,
	workingBranch: "ytimesy/fix-parser-0c4a1e",
} as unknown as AgentSessionRecord;

it("commits a root chat's turn without the verification gate and returns where it was pushed", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	identity.forToken.mockResolvedValue({
		name: "Het",
		email: "7+het@users.noreply.github.com",
	});
	verification.mockClear();
	publication.publish.mockResolvedValue({
		branch: "ytimesy/fix-parser-0c4a1e",
		pullRequestUrl: "https://github.com/owner/primary/pull/3",
	});
	const runtime = new MemoryWorkspaceRuntime();
	const outcome = await commitCompletedSessionTurn(chat, items, runtime);
	expect(verification).not.toHaveBeenCalled();
	expect(runtime.commands).toHaveLength(1);
	expect(runtime.commands[0].argv[3]).toBe("/home/ubuntu/primary");
	// No verified tree: the commit takes whatever the turn left.
	expect(runtime.commands[0].argv[6]).toBe("");
	expect(runtime.commands[0].argv[5]).toContain("Agent: Fix parser");
	// The request rides in the body, after the subject.
	expect(runtime.commands[0].argv[5]).toContain(
		"Agent: Fix parser\n\nRequest: Fix parser",
	);
	// The user is the author, so GitHub counts the commit as theirs.
	expect(runtime.commands[0].argv[5]).toContain(
		"GIT_AUTHOR_EMAIL='7+het@users.noreply.github.com'",
	);
	expect(runtime.commands[0].argv[5]).toContain(
		"GIT_COMMITTER_EMAIL='328807657+ytimesy-agent[bot]@users.noreply.github.com'",
	);
	expect(publication.publish).toHaveBeenCalledWith(
		chat,
		runtime,
		runtime.commands[0].argv[4],
		expect.objectContaining({ description: null, files: [] }),
		new Set(["owner/primary"]),
		undefined,
		false,
	);
	expect(outcome).toEqual({
		publication: {
			branch: "ytimesy/fix-parser-0c4a1e",
			pullRequestUrl: "https://github.com/owner/primary/pull/3",
		},
	});
});

it.each(["codex", "api"] as const)(
	"commits and publishes a %s-harness root chat the same way",
	async (harness) => {
		lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
		verification.mockClear();
		publication.publish.mockClear();
		publication.publish.mockResolvedValue({
			branch: "ytimesy/fix-parser-0c4a1e",
			pullRequestUrl: null,
		});
		const runtime = new MemoryWorkspaceRuntime();
		const outcome = await commitCompletedSessionTurn(
			{ ...chat, harness },
			items,
			runtime,
		);
		expect(verification).not.toHaveBeenCalled();
		expect(runtime.commands).toHaveLength(1);
		expect(publication.publish).toHaveBeenCalledOnce();
		expect(outcome?.publication?.branch).toBe("ytimesy/fix-parser-0c4a1e");
	},
);

it("neither commits nor pushes a root chat of an eval user or evaluation run", async () => {
	publication.excluded.mockResolvedValueOnce(true);
	publication.publish.mockClear();
	lookup.mockClear();
	const runtime = new MemoryWorkspaceRuntime();
	await expect(
		commitCompletedSessionTurn(chat, items, runtime),
	).resolves.toBeUndefined();
	expect(lookup).not.toHaveBeenCalled();
	expect(runtime.commands).toHaveLength(0);
	expect(publication.publish).not.toHaveBeenCalled();
});

it("authors the commit as the authenticated GitHub user and credits the bot as co-author", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	const runtime = new MemoryWorkspaceRuntime();
	await commitCompletedSessionTurn(chat, items, runtime);
	expect(runtime.commands[0].argv[5]).toContain(
		"Co-authored-by: ytimesy-agent[bot] <328807657+ytimesy-agent[bot]@users.noreply.github.com>",
	);
	expect(runtime.commands[0].argv[5]).toContain("GIT_AUTHOR_NAME='Het'");
	expect(runtime.commands[0].argv[5]).not.toContain(
		"Co-authored-by: Het <7+het@users.noreply.github.com>",
	);
});

it("keeps the bot as author, without inventing a human, when GitHub cannot verify one", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	identity.forToken.mockResolvedValue(null);
	const runtime = new MemoryWorkspaceRuntime();
	await commitCompletedSessionTurn(chat, items, runtime);
	expect(runtime.commands[0].argv[5]).toContain(
		"Co-authored-by: ytimesy-agent[bot] <328807657+ytimesy-agent[bot]@users.noreply.github.com>",
	);
	expect(runtime.commands[0].argv[5]).not.toContain(
		"7+het@users.noreply.github.com",
	);
	expect(runtime.commands[0].argv[5]).toContain(
		"GIT_AUTHOR_EMAIL='328807657+ytimesy-agent[bot]@users.noreply.github.com'",
	);
});

it("keeps a chat's turn successful and explains when GitHub refuses the push", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	publication.publish.mockRejectedValueOnce(
		new Response("Repository access is unavailable.", { status: 403 }),
	);
	const outcome = await commitCompletedSessionTurn(
		chat,
		items,
		new MemoryWorkspaceRuntime(),
	);
	expect(outcome?.notice).toMatch(/not pushed: ytimesy has no write access/);
});

it("passes a skip reason through and reports a chat commit that Git refused", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	const { ChatPublicationSkipped } = await import("./turn-publication");
	publication.publish.mockRejectedValueOnce(
		new ChatPublicationSkipped("works directly on main"),
	);
	expect(
		(
			await commitCompletedSessionTurn(
				chat,
				items,
				new MemoryWorkspaceRuntime(),
			)
		)?.notice,
	).toBe("works directly on main");
	publication.publish.mockClear();
	const refused = await commitCompletedSessionTurn(
		chat,
		items,
		new MemoryWorkspaceRuntime({
			exitCode: 1,
			stdout: "",
			stderr: "Refusing to commit a likely secret",
		}),
	);
	expect(refused?.notice).toContain("not committed in owner/primary");
	expect(publication.publish).not.toHaveBeenCalled();
});

it("rethrows when the turn was aborted while publishing", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	const abort = new AbortController();
	publication.publish.mockImplementationOnce(async () => {
		abort.abort(new Error("turn stopped"));
		throw new Error("push interrupted");
	});
	await expect(
		commitCompletedSessionTurn(
			chat,
			items,
			new MemoryWorkspaceRuntime(),
			abort.signal,
		),
	).rejects.toThrow("turn stopped");
});

/** A machine whose checkouts report `head` as their `.git/HEAD`. */
class CheckoutRuntime extends MemoryWorkspaceRuntime {
	constructor(private readonly head: string) {
		super();
	}
	async readTextFile(_providerRef: string, path: string) {
		return path.endsWith("/.git/HEAD") ? this.head : null;
	}
}

it("follows the branch the agent switched the chat to and publishes it", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	branchStore.save.mockClear();
	publication.publish.mockClear();
	publication.publish.mockResolvedValue({
		branch: "agent/hotfix",
		pullRequestUrl: null,
	});
	const switched = {
		...chat,
		selectedBranch: "agent/hotfix",
		workingBranch: "agent/hotfix",
		baseBranch: "release",
	} as AgentSessionRecord;
	branchStore.save.mockResolvedValueOnce(switched);
	await commitCompletedSessionTurn(
		{ ...chat, baseBranch: "release" } as AgentSessionRecord,
		items,
		new CheckoutRuntime("ref: refs/heads/agent/hotfix\n"),
	);
	expect(branchStore.save).toHaveBeenCalledWith(
		"alice",
		"chat-root",
		"agent/hotfix",
	);
	expect(publication.publish.mock.calls[0][0]).toMatchObject({
		workingBranch: "agent/hotfix",
		baseBranch: "release",
		providerRef: "writer-vm",
	});
});

it("leaves the chat's branch alone when the checkout stays on it or HEAD is detached", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	for (const head of [
		`ref: refs/heads/${chat.workingBranch}\n`,
		`${"c".repeat(40)}\n`,
	]) {
		branchStore.save.mockClear();
		publication.publish.mockClear();
		await commitCompletedSessionTurn(chat, items, new CheckoutRuntime(head));
		expect(branchStore.save).not.toHaveBeenCalled();
		expect(publication.publish.mock.calls[0][0]).toEqual(chat);
	}
});

describe("commitSubject", () => {
	it("keeps a request that describes the change", () => {
		expect(
			commitSubject("Add a --version flag to hello.py", "Add a docstring"),
		).toBe("Add a --version flag to hello.py");
	});
	it("uses the chat title for a bare reply", () => {
		for (const reply of [
			"Yes, do that.",
			"ok",
			"continue",
			"Sounds good, go ahead",
		])
			expect(commitSubject(reply, "Add a one-line docstring to main")).toBe(
				"Add a one-line docstring to main",
			);
	});
	it("keeps a long reply that names the change", () => {
		expect(
			commitSubject(
				"Yes, and also rename the --shout flag to --loud everywhere",
				"t",
			),
		).toBe("Yes, and also rename the --shout flag to --loud everywhere");
	});
	it("falls back to whichever is present, capped at 72 characters", () => {
		expect(commitSubject(null, "Title")).toBe("Title");
		expect(commitSubject("ok", "")).toBe("ok");
		expect(commitSubject("x ".repeat(60), null)).toHaveLength(72);
	});
});

describe("answerSubject", () => {
	it("takes the first sentence of the answer as plain text", () => {
		expect(
			answerSubject(
				"**Memory now defaults to the spec loop.** The builder searches it itself.\n\nMore detail.",
			),
		).toBe("Memory now defaults to the spec loop");
		expect(answerSubject("## Fixed the `commitSubject` fallback\nbody")).toBe(
			"Fixed the commitSubject fallback",
		);
	});
	it("cuts a long sentence at a word, within 72 characters", () => {
		const subject = answerSubject(
			"Subagents now get read-only search and read tools over the memory snapshot instead of nothing",
		);
		expect(subject).toBe(
			"Subagents now get read-only search and read tools over the memory",
		);
		expect(subject?.length).toBeLessThanOrEqual(72);
	});
	it("says nothing when the answer does not open with an outcome", () => {
		for (const answer of [
			"Yes, that makes sense.",
			"Sorry, I broke it.",
			"Should I also rename the flag?",
			"Done.",
			"```\ncode\n```",
			"",
			null,
		])
			expect(answerSubject(answer)).toBeNull();
	});
	it("heads a commit before the request does, and the request stays as the fallback", () => {
		expect(
			commitSubject(
				"then do it please",
				"Memory",
				"Both changes are already committed on the branch.",
			),
		).toBe("Both changes are already committed on the branch");
		expect(commitSubject("Add a --version flag to hello.py", "t", "Yes.")).toBe(
			"Add a --version flag to hello.py",
		);
	});
});

describe("commitSessionTurn", () => {
	it("commits now and leaves the push and pull request to its publish", async () => {
		const { commitSessionTurn } = await import("./turn-commit");
		lookup.mockResolvedValue({
			fullName: "owner/primary",
			repositoryId: 1,
			installationId: 2,
			branch: "main",
		});
		publication.publish.mockClear();
		publication.publish.mockResolvedValue({
			branch: "ytimesy/fix-parser-0c4a1e",
			pullRequestUrl: "https://github.com/owner/primary/pull/3",
		});
		const chat = { ...session, parentSessionId: null, agentRole: null };
		const runtime = new MemoryWorkspaceRuntime();
		const committed = await commitSessionTurn(chat, items, runtime);
		expect(runtime.commands).toHaveLength(1);
		expect(publication.publish).not.toHaveBeenCalled();
		expect(committed?.publish).toBeTypeOf("function");
		await expect(committed?.publish?.()).resolves.toEqual({
			publication: {
				branch: "ytimesy/fix-parser-0c4a1e",
				pullRequestUrl: "https://github.com/owner/primary/pull/3",
			},
		});
	});

	it("has nothing to publish when the checkout holds no unpushed commits", async () => {
		const { commitSessionTurn } = await import("./turn-commit");
		lookup.mockResolvedValue({
			fullName: "owner/primary",
			repositoryId: 1,
			installationId: 2,
			branch: "main",
		});
		publication.pending.mockResolvedValueOnce(new Set());
		const chat = { ...session, parentSessionId: null, agentRole: null };
		const committed = await commitSessionTurn(
			chat,
			items,
			new MemoryWorkspaceRuntime(),
		);
		expect(committed).toEqual({});
	});
});

describe("a turn with nothing new to push", () => {
	const nothingNew = () =>
		publication.pending.mockResolvedValueOnce(new Set<string>());
	const opened: SessionItem = {
		kind: "notice",
		id: SessionItemId("n1"),
		message: "Opened draft PR #128",
		pullRequest: {
			state: "opened",
			number: 128,
			url: "https://github.com/owner/primary/pull/128",
			draft: true,
			created: true,
		},
	} as SessionItem;

	const commitSessionTurn = async (...args: unknown[]) =>
		(await import("./turn-commit")).commitSessionTurn(
			...(args as Parameters<typeof import("./turn-commit").commitSessionTurn>),
		);

	it("still hands off a pushed branch that has no pull request recorded", async () => {
		lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
		publication.publish.mockClear();
		publication.publish.mockResolvedValue(undefined);
		nothingNew();
		const outcome = await commitSessionTurn(
			chat,
			items,
			new MemoryWorkspaceRuntime(),
		);
		await (
			outcome as { publish?: (cb: () => void) => Promise<unknown> }
		).publish?.(() => undefined);
		expect(outcome.publish).toBeTypeOf("function");
		expect(publication.publish).toHaveBeenCalledWith(
			chat,
			expect.anything(),
			expect.any(String),
			expect.anything(),
			new Set(["owner/primary"]),
			expect.anything(),
			true,
		);
	});

	it("leaves a chat that already shows its pull request alone: no GitHub read", async () => {
		lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
		nothingNew();
		const outcome = await commitSessionTurn(
			chat,
			[...items, opened],
			new MemoryWorkspaceRuntime(),
		);
		expect(outcome.publish).toBeUndefined();
	});

	it("does nothing for a chat with no branch yet", async () => {
		lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
		nothingNew();
		const outcome = await commitSessionTurn(
			{ ...chat, workingBranch: null } as AgentSessionRecord,
			items,
			new MemoryWorkspaceRuntime(),
		);
		expect(outcome.publish).toBeUndefined();
	});
});
