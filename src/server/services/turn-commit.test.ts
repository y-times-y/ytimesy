import { expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { MemoryWorkspaceRuntime } from "../adapters/workspace-runtime";
import { commitCompletedSessionTurn } from "./turn-commit";

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
const publication = vi.hoisted(() => ({
	publish: vi.fn(),
	excluded: vi.fn(async () => false),
}));
vi.mock("./turn-publication", async (original) => ({
	ChatPublicationSkipped: (
		await original<typeof import("./turn-publication")>()
	).ChatPublicationSkipped,
	publishCompletedSessionTurn: publication.publish,
	turnPublicationExcluded: publication.excluded,
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
	expect(publication.publish).toHaveBeenCalledWith(
		chat,
		runtime,
		runtime.commands[0].argv[4],
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
