import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	workspace: vi.fn(),
	session: vi.fn(),
	list: vi.fn(),
	insert: vi.fn(),
	reusable: vi.fn(),
	blockItems: vi.fn(async () => new Map<string, unknown[]>()),
}));
vi.mock("#/server/adapters/workspaces", () => ({
	workspaceForProject: mocks.workspace,
	saveTemplateSnapshot: vi.fn(),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
	agentSessionMetadataForOwner: mocks.session,
	listAgentSessions: mocks.list,
	latestAgentSessionMetadata: async (userId: string, projectId: string) =>
		(await mocks.list(userId, projectId))[0] ?? null,
	insertAgentSession: mocks.insert,
	reusableEmptyChat: mocks.reusable,
	childAgentSession: vi.fn(),
	deleteAgentSessionForOwner: vi.fn(),
	descendantAgentSessionMetadata: vi.fn(),
	listedModelBlockItemsForOwner: mocks.blockItems,
	providerRefsHeldOutside: vi.fn(),
	saveAgentSessionProviderRef: vi.fn(async () => undefined),
	selectAgentSessionHarness: vi.fn(),
}));
vi.mock("../adapters/checkpoints/storage", async (importOriginal) => ({
	...(await importOriginal<object>()),
	checkpointStorageConfigured: () => false,
}));
vi.mock("#/domain/project-workspace", () => ({
	workspaceEnvironmentIsReady: () => true,
}));
vi.mock("../adapters/conversation-fork", () => ({
	conversationForkPending: async () => false,
}));
vi.mock("#/server/adapters/project-machine-size", () => ({
	projectMachineSize: async () => undefined,
}));
vi.mock("./environment-services", () => ({
	startEnvironmentServices: async (
		machines: Pick<WorkspaceMachines, "exec" | "writeTextFile">,
		vm: never,
	) => {
		await machines.exec(vm, "start services", 60_000);
		await machines.writeTextFile(vm, "/report", "services started");
	},
}));

const { bindAgentSessionMachine, openAgentSession, peekAgentSessionMachine } =
	await import("./agent-session-machine");
const { cancellableMachines } = await import("./machine-call-signal");

const chat = {
	id: "chat",
	userId: "owner",
	projectId: "project",
	harness: "api",
	providerRef: "vm-1",
	parentSessionId: null,
	listedModelId: null,
	items: [],
};
beforeEach(() => {
	mocks.workspace.mockReset().mockResolvedValue({
		id: "workspace",
		providerRef: "template",
		templateSnapshotId: "snap",
	});
	mocks.session.mockReset().mockResolvedValue(chat);
	mocks.list.mockReset().mockResolvedValue([chat]);
	mocks.insert.mockReset().mockImplementation(async (input) => ({
		...chat,
		id: "new",
		providerRef: null,
		listedModelId: input.listedModelId,
	}));
	mocks.reusable.mockReset().mockResolvedValue(null);
});

it("binds a named chat from its own row, never the project's chat list", async () => {
	const ensureRunning = vi.fn(async () => {});
	const bound = await bindAgentSessionMachine(
		{
			restoreRetainedSession: async () => "vm-1",
			ensureRunning,
		} as never,
		{
			userId: "owner",
			projectId: "project",
			harness: "api",
			sessionId: "chat",
		},
	);
	expect(bound.providerRef).toBe("vm-1");
	expect(mocks.session).toHaveBeenCalledWith("owner", "chat");
	expect(mocks.list).not.toHaveBeenCalled();
});

it("still refuses a named chat that is missing or in another project", async () => {
	const machines = { ensureRunning: vi.fn() } as never;
	const input = {
		userId: "owner",
		projectId: "project",
		harness: "api",
		sessionId: "chat",
	} as const;
	mocks.session.mockResolvedValueOnce(null);
	await expect(bindAgentSessionMachine(machines, input)).rejects.toThrow(
		"Agent session is not available.",
	);
	mocks.session.mockResolvedValueOnce({ ...chat, projectId: "other" });
	await expect(bindAgentSessionMachine(machines, input)).rejects.toThrow(
		"Agent session is not in this project.",
	);
});

it("reads the chat list for the model a new chat inherits", async () => {
	mocks.list.mockResolvedValue([
		{ ...chat, listedModelId: "api/connection/model" },
	]);
	await openAgentSession({
		userId: "owner",
		projectId: "project",
		harness: "api",
	});
	expect(mocks.list).toHaveBeenCalledOnce();
	expect(mocks.insert).toHaveBeenCalledWith(
		expect.objectContaining({ listedModelId: "api/connection/model" }),
	);
});

it("skips a model the provider blocked, reading only the rows that say so", async () => {
	mocks.list.mockResolvedValue([
		{ ...chat, id: "blocked", listedModelId: "api/connection/blocked" },
		{ ...chat, id: "other-runtime", harness: "codex", listedModelId: "gpt" },
		{ ...chat, id: "fine", listedModelId: "api/connection/fine" },
	]);
	mocks.blockItems.mockResolvedValueOnce(
		new Map([
			[
				"blocked",
				[
					{
						kind: "error",
						message: "[user_blocked] access has been restricted",
					},
				],
			],
		]),
	);
	await openAgentSession({
		userId: "owner",
		projectId: "project",
		harness: "api",
	});
	// Only the chats on this runtime that name a model; no transcript is read.
	expect(mocks.blockItems).toHaveBeenCalledWith("owner", ["blocked", "fine"]);
	expect(mocks.insert).toHaveBeenCalledWith(
		expect.objectContaining({ listedModelId: "api/connection/fine" }),
	);
});

it("peeks a named chat by id and the latest chat from the list", async () => {
	expect(
		await peekAgentSessionMachine({
			userId: "owner",
			projectId: "project",
			sessionId: "chat",
		}),
	).toEqual({ session: chat, providerRef: "vm-1" });
	expect(mocks.list).not.toHaveBeenCalled();
	expect(
		(await peekAgentSessionMachine({ userId: "owner", projectId: "project" }))
			.session,
	).toBe(chat);
	expect(mocks.list).toHaveBeenCalledOnce();
});

it("starts a fresh copy's saved services to the end even if the turn stops", async () => {
	mocks.session.mockResolvedValue({ ...chat, providerRef: null });
	let releaseServices = () => {};
	const servicesStarted = new Promise<void>((resolve) => {
		releaseServices = resolve;
	});
	const writeTextFile = vi.fn(async () => {});
	const raw = {
		provisionSession: vi.fn(async () => "vm-new"),
		exec: vi.fn(async (_vm: unknown, command: string) => {
			// The services' start answers only after the user's Stop.
			if (command === "start services") await servicesStarted;
			return { exitCode: 0, stdout: "", stderr: "" };
		}),
		writeTextFile,
	};
	const turn = new AbortController();
	const bound = await bindAgentSessionMachine(
		cancellableMachines(raw as unknown as WorkspaceMachines, turn.signal),
		{
			userId: "owner",
			projectId: "project",
			harness: "api",
			sessionId: "chat",
		},
	);
	expect(bound.providerRef).toBe("vm-new");
	turn.abort(new Error("Stopped"));
	releaseServices();
	await vi.waitFor(() =>
		expect(writeTextFile).toHaveBeenCalledWith(
			"vm-new",
			"/report",
			"services started",
		),
	);
});

it("replaces a retained VM that the provider deleted instead of failing the turn", async () => {
	const gone = Object.assign(new Error("not found"), {
		name: "WorkspaceProvisionError",
		detail: "FreestyleApiError 404 NOT_FOUND /v5/vms/vm-1: not found: vm vm-1",
	});
	const provisioned: string[] = [];
	const machines = {
		restoreRetainedSession: async () => "vm-1",
		ensureRunning: async (id: string) => {
			if (id === "vm-1") throw gone;
		},
		snapshotEnvironment: async () => "snap",
		provisionSession: async (slug: string) => {
			provisioned.push(slug);
			return "vm-new";
		},
		rebindRetainedSession: async () => {},
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		writeTextFile: async () => {},
	};
	const bound = await bindAgentSessionMachine(machines as never, {
		userId: "owner",
		projectId: "project",
		harness: "api",
		sessionId: "chat",
	});
	expect(bound.providerRef).toBe("vm-new");
	expect(provisioned).toHaveLength(1);
});
