import { expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { MemoryWorkspaceRuntime } from "../adapters/workspace-runtime";
import { commitCompletedSessionTurn } from "./turn-commit";

const lookup = vi.hoisted(() => vi.fn());
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
