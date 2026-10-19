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
	parentSessionId: "lead",
	title: "Fix parser",
	taskAccess: "read_write",
	taskPlacement: "fresh",
} as AgentSessionRecord;
const items: SessionItem[] = [
	{
		kind: "userMessage",
		id: SessionItemId("user-1"),
		text: "Fix parser",
		timing: { startedAt: 100 },
	},
];

it.each(["shared", "read_only child", "unbound"])(
	"skips %s sessions without accessing a project or machine",
	async (kind) => {
		lookup.mockClear();
		const runtime = new MemoryWorkspaceRuntime();
		await commitCompletedSessionTurn(
			{
				...session,
				...(kind === "shared"
					? { taskPlacement: "shared" }
					: kind === "read_only child"
						? { taskAccess: "read_only" }
						: { providerRef: null }),
			},
			items,
			runtime,
		);
		expect(lookup).not.toHaveBeenCalled();
		expect(runtime.commands).toHaveLength(0);
	},
);

it("commits every owned repository on the executor and keeps identity stable across native item ids", async () => {
	lookup.mockResolvedValue({
		fullName: "owner/primary",
		branch: "main",
		repositories: [
			{ fullName: "owner/primary", branch: "main" },
			{ fullName: "owner/secondary", branch: "main" },
		],
	});
	const runtime = new MemoryWorkspaceRuntime();
	await commitCompletedSessionTurn(session, items, runtime);
	await commitCompletedSessionTurn(
		session,
		[{ ...items[0], id: SessionItemId("native-id") }],
		runtime,
	);
	expect(lookup).toHaveBeenCalledWith("alice", "project-1");
	expect(runtime.commands.map((command) => command.providerRef)).toEqual(
		Array(4).fill("writer-vm"),
	);
	expect(runtime.commands[0].argv[3]).toBe("/home/ubuntu/primary");
	expect(runtime.commands[1].argv[3]).toBe("/home/ubuntu/secondary");
	expect(runtime.commands[0].argv[4]).toBe(runtime.commands[2].argv[4]);
	await commitCompletedSessionTurn(
		session,
		[{ ...items[0], timing: { startedAt: 200 } } as SessionItem],
		runtime,
	);
	expect(runtime.commands[4].argv[4]).not.toBe(runtime.commands[0].argv[4]);
});

it("never commits or publishes registered evaluation tasks", async () => {
	vi.stubEnv("YTIMESY_HARNESS_EVALUATION_ENABLED", "1");
	try {
		evaluation.mockResolvedValue({ id: "evaluation" });
		lookup.mockClear();
		const runtime = new MemoryWorkspaceRuntime();
		const publishCompletedSessionTurn = publication.publish;
		publishCompletedSessionTurn.mockClear();
		await commitCompletedSessionTurn(session, items, runtime);
		expect(lookup).toHaveBeenCalledWith("alice", "project-1");
		expect(verification).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: session.id }),
		);
		expect(runtime.commands).toHaveLength(0);
		expect(publishCompletedSessionTurn).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllEnvs();
	}
});

it("never commits or publishes when authoritative verification fails", async () => {
	lookup.mockResolvedValue({ fullName: "owner/primary", branch: "main" });
	verification.mockRejectedValueOnce(new Error("required check failed"));
	const runtime = new MemoryWorkspaceRuntime();
	const publishCompletedSessionTurn = publication.publish;
	publishCompletedSessionTurn.mockClear();
	await expect(
		commitCompletedSessionTurn(session, items, runtime),
	).rejects.toThrow("required check failed");
	expect(runtime.commands).toHaveLength(0);
	expect(publishCompletedSessionTurn).not.toHaveBeenCalled();
});

it("verifies and commits under the checkout's recorded path, wherever its home directory is", async () => {
	lookup.mockResolvedValue({
		fullName: "owner/primary",
		branch: "main",
		repositories: [
			{ fullName: "owner/primary", branch: "main" },
			{ fullName: "owner/secondary", branch: "main" },
		],
	});
	verification.mockClear();
	const runtime = Object.assign(new MemoryWorkspaceRuntime(), {
		readTextFile: async (_providerRef: string, path: string) =>
			path === "/tmp/ytimesy-project-cwd" ? "/root/primary\n" : null,
	});
	await commitCompletedSessionTurn(session, items, runtime);
	expect(
		(verification.mock.calls as unknown as [{ directory: string }][]).map(
			([input]) => input.directory,
		),
	).toEqual(["/root/primary", "/root/secondary"]);
	expect(runtime.commands[0].argv[3]).toBe("/root/primary");
});

const chat = {
	...session,
	id: "chat-root",
	parentSessionId: null,
	taskAccess: null,
	taskPlacement: null,
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
