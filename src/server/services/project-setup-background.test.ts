import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import {
	ENVIRONMENT_SETUP_PROMPT,
	initialSetupMessageId,
} from "#/domain/environment-setup";
import { SETUP_WAITS_FOR_MODEL } from "#/domain/setup-model";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	workspace: vi.fn(),
	otherSetup: vi.fn(async (..._args: unknown[]) => null as string | null),
	lastUsed: vi.fn(async (..._args: unknown[]) => null as unknown),
	account: vi.fn(async (..._args: unknown[]) => ({
		managed: true,
		account: { status: "connected" },
	})),
	codex: vi.fn(async (..._args: unknown[]) => [{ id: "gpt-6.1-sol" }]),
	api: vi.fn(async (..._args: unknown[]) => [] as { id: string }[]),
	send: vi.fn(),
	claim: vi.fn(),
	mark: vi.fn(async (..._args: unknown[]) => true),
	replaceItems: vi.fn(async (..._args: unknown[]) => true),
	query: vi.fn(),
}));
vi.mock("../adapters/workspaces", () => ({
	workspaceForProject: mocks.workspace,
}));
vi.mock("../adapters/environment-setup-chats", () => ({
	otherProjectSetupChat: mocks.otherSetup,
	markEnvironmentSetupChat: mocks.mark,
}));
vi.mock("../adapters/agent-sessions", () => ({
	claimInitialSetupChat: mocks.claim,
	latestListedModelForUser: mocks.lastUsed,
}));
vi.mock("../adapters/background-command-sessions", () => ({
	replaceIdleSessionItems: mocks.replaceItems,
}));
vi.mock("../adapters/codex-subscription", () => ({
	codexSubscriptionCatalog: mocks.codex,
}));
vi.mock("../auth/agent-account", () => ({
	loadAgentAccountState: mocks.account,
}));
vi.mock("./api-workspace-session", () => ({ apiModelCatalog: mocks.api }));
vi.mock("./queued-user-messages", () => ({ sendComposerMessage: mocks.send }));
vi.mock("../adapters/database", () => ({
	database: () => ({ query: mocks.query }),
}));

const {
	startProjectSetupAfterFirstBuild,
	startProjectSetupForWorkspace,
	startProjectSetupInBackground,
} = await import("./project-setup-background");

const machines = {} as WorkspaceMachines;

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockClear();
	mocks.workspace.mockResolvedValue({ id: "workspace", status: "cloning" });
	mocks.otherSetup.mockResolvedValue(null);
	mocks.lastUsed.mockResolvedValue(null);
	mocks.account.mockResolvedValue({
		managed: true,
		account: { status: "connected" },
	});
	mocks.codex.mockResolvedValue([{ id: "gpt-6.1-sol" }]);
	mocks.api.mockResolvedValue([]);
	mocks.send.mockReturnValue(Effect.succeed({}));
});

it("starts a new project's setup on the server in its own chat, on the person's model", async () => {
	mocks.lastUsed.mockResolvedValue({
		harnessId: "codex",
		modelId: "gpt-6.1-sol",
	});
	expect(
		await startProjectSetupInBackground(machines, "owner", "project"),
	).toBe("started");
	expect(mocks.send).toHaveBeenCalledOnce();
	const [, scope, send] = mocks.send.mock.calls[0] as unknown[];
	expect(scope).toEqual({
		userId: "owner",
		projectId: "project",
		harnessId: "codex",
		createNew: true,
	});
	expect(send).toEqual({
		text: ENVIRONMENT_SETUP_PROMPT,
		modelId: "gpt-6.1-sol",
		idempotencyKey: initialSetupMessageId("project"),
		environmentSetup: true,
	});
});

it("falls back to a connected route when ChatGPT is not signed in", async () => {
	mocks.lastUsed.mockResolvedValue({
		harnessId: "codex",
		modelId: "gpt-6.1-sol",
	});
	mocks.account.mockResolvedValue({
		managed: false,
		account: { status: "disconnected" },
	});
	mocks.api.mockResolvedValue([{ id: "openrouter|z-ai/glm-5" }]);
	await startProjectSetupInBackground(machines, "owner", "project");
	expect(mocks.codex).not.toHaveBeenCalled();
	const [, scope, send] = mocks.send.mock.calls[0] as [
		unknown,
		{ harnessId: string },
		{ modelId: string },
	];
	expect(scope.harnessId).toBe("api");
	expect(send.modelId).toBe("openrouter|z-ai/glm-5");
});

it("starts nothing for a project that has its setup chat", async () => {
	mocks.otherSetup.mockResolvedValue("setup-chat");
	expect(
		await startProjectSetupInBackground(machines, "owner", "project"),
	).toBe("exists");
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.claim).not.toHaveBeenCalled();
});

it("opens the setup chat with one line saying what it waits for when no model is connected", async () => {
	mocks.account.mockResolvedValue({
		managed: false,
		account: { status: "disconnected" },
	});
	mocks.claim.mockResolvedValue({
		session: { id: "setup-chat" },
		created: true,
	});
	expect(
		await startProjectSetupInBackground(machines, "owner", "project"),
	).toBe("waits-for-model");
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.mark).toHaveBeenCalledWith(
		"owner",
		"setup-chat",
		"Set up project",
	);
	const [, , expected, next] = mocks.replaceItems.mock.calls[0] as unknown[];
	expect(expected).toEqual([]);
	expect(next).toEqual([
		expect.objectContaining({ kind: "notice", message: SETUP_WAITS_FOR_MODEL }),
	]);
});

it("starts nothing without a workspace", async () => {
	mocks.workspace.mockResolvedValue(null);
	expect(
		await startProjectSetupInBackground(machines, "owner", "project"),
	).toBe("no-workspace");
	expect(mocks.send).not.toHaveBeenCalled();
});

it("the add-time job and the first build's finish start it; an older project's rebuild never does", async () => {
	const workspaceRow = (readyBuilds: number) => ({
		rows: [
			{
				user_id: "owner",
				project_id: "project",
				ready_builds: String(readyBuilds),
			},
		],
	});
	mocks.query.mockResolvedValue(workspaceRow(0));
	expect(await startProjectSetupForWorkspace(machines, "workspace")).toBe(
		"started",
	);
	mocks.query.mockResolvedValue(workspaceRow(1));
	expect(await startProjectSetupAfterFirstBuild(machines, "workspace")).toBe(
		"started",
	);
	mocks.send.mockClear();
	mocks.query.mockResolvedValue(workspaceRow(2));
	expect(
		await startProjectSetupAfterFirstBuild(machines, "workspace"),
	).toBeNull();
	expect(await startProjectSetupForWorkspace(machines, "workspace")).toBeNull();
	expect(mocks.send).not.toHaveBeenCalled();
});
