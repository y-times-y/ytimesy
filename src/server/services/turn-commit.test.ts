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
vi.mock("./turn-publication", () => ({ publishCompletedSessionTurn: vi.fn() }));

const session = {
	id: "chat-1",
	userId: "alice",
	projectId: "project-1",
	providerRef: "writer-vm",
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

it.each(["shared", "read_only", "unbound"])(
	"skips %s sessions without accessing a project or machine",
	async (kind) => {
		lookup.mockClear();
		const runtime = new MemoryWorkspaceRuntime();
		await commitCompletedSessionTurn(
			{
				...session,
				...(kind === "shared"
					? { taskPlacement: "shared" }
					: kind === "read_only"
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
		const { publishCompletedSessionTurn } = await import("./turn-publication");
		vi.mocked(publishCompletedSessionTurn).mockClear();
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
	const { publishCompletedSessionTurn } = await import("./turn-publication");
	vi.mocked(publishCompletedSessionTurn).mockClear();
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
