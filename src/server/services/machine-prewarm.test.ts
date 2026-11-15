import { beforeEach, expect, it, vi } from "vitest";
import { prewarmChatMachine, sweepUnusedChatMachines } from "./machine-prewarm";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	claim: vi.fn(async () => true),
	finish: vi.fn(async () => {}),
	unused: vi.fn(
		async (): Promise<{ session_id: string; vm_id: string | null }[]> => [],
	),
	workspace: vi.fn(async () => ({ templateSnapshotId: "snap-1" })),
	size: vi.fn(async () => "large"),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: mocks.session,
	agentSessionHasItems: async (user: string, id: string) => {
		const chat = (await mocks.session(user, id)) as { items?: unknown } | null;
		return Array.isArray(chat?.items) && chat.items.length > 0;
	},
}));
vi.mock("../adapters/machine-prewarm", () => ({
	claimMachinePrewarm: mocks.claim,
	finishMachinePrewarm: mocks.finish,
	unusedMachinePrewarms: mocks.unused,
}));
vi.mock("../adapters/workspaces", () => ({
	workspaceForProject: mocks.workspace,
}));
vi.mock("../adapters/project-machine-size", () => ({
	projectMachineSize: mocks.size,
}));

const chat = {
	id: "11111111-1111-4111-8111-111111111111",
	projectId: "project",
	parentSessionId: null,
	providerRef: null,
	turnStatus: "idle",
	items: [],
};
const input = { userId: "owner", projectId: "project", sessionId: chat.id };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.session.mockResolvedValue(chat);
	mocks.claim.mockResolvedValue(true);
});

it("copies an empty chat's machine by its slug and records the copy", async () => {
	const provisionSession = vi.fn(async () => "vm-1");
	expect(await prewarmChatMachine({ provisionSession } as never, input)).toBe(
		"started",
	);
	expect(provisionSession).toHaveBeenCalledWith(
		"ytimesy-ag-1111111111114111",
		"snap-1",
		"large",
	);
	expect(mocks.finish).toHaveBeenCalledWith(chat.id, {
		snapshotId: "snap-1",
		vmId: "vm-1",
	});
});

it.each([
	["a chat with a machine", { ...chat, providerRef: "vm-0" }],
	[
		"a chat with messages",
		{ ...chat, items: [{ kind: "userMessage", id: "m", text: "hi" }] },
	],
	["a running chat", { ...chat, turnStatus: "running" }],
	["a subagent", { ...chat, parentSessionId: "root" }],
	["another project's chat", { ...chat, projectId: "other" }],
])("leaves %s alone", async (_case, session) => {
	mocks.session.mockResolvedValue(session);
	const provisionSession = vi.fn();
	expect(await prewarmChatMachine({ provisionSession } as never, input)).toBe(
		"skipped",
	);
	expect(mocks.claim).not.toHaveBeenCalled();
	expect(provisionSession).not.toHaveBeenCalled();
});

it("copies nothing when the claim is refused (another copy waits)", async () => {
	mocks.claim.mockResolvedValue(false);
	const provisionSession = vi.fn();
	expect(await prewarmChatMachine({ provisionSession } as never, input)).toBe(
		"skipped",
	);
	expect(provisionSession).not.toHaveBeenCalled();
});

it("records a failed copy so the first turn makes its own", async () => {
	const provisionSession = vi.fn(async () => {
		throw new Error("Usage limit reached");
	});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	await prewarmChatMachine({ provisionSession } as never, input);
	expect(mocks.finish).toHaveBeenCalledWith(chat.id, { failed: true });
});

it("deletes copies nothing was sent to and marks them swept", async () => {
	mocks.unused.mockResolvedValue([
		{ session_id: "a", vm_id: "vm-a" },
		{ session_id: "b", vm_id: null },
	]);
	const destroy = vi.fn(async () => {});
	await sweepUnusedChatMachines({ destroy } as never);
	expect(destroy).toHaveBeenCalledExactlyOnceWith("vm-a");
	expect(mocks.finish).toHaveBeenCalledWith("a", { swept: true });
	expect(mocks.finish).toHaveBeenCalledWith("b", { swept: true });
});
