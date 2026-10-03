import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { deferredApiTurnWorkspace } from "./api-turn-workspace";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	root: vi.fn(),
	child: vi.fn(),
	checkout: vi.fn(),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.read,
}));
vi.mock("./agent-session-machine", () => ({
	bindAgentSessionMachine: mocks.root,
	bindPreparedAgentTaskMachine: mocks.child,
}));
vi.mock("./session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));
vi.mock("./project-workspace", () => ({
	loadTenantProjectCheckout: () => Effect.succeed({}),
	ensureProjectCheckout: () => {
		mocks.checkout();
		return Effect.void;
	},
}));

const root = {
	id: "root",
	userId: "owner",
	projectId: "project",
	harness: "codex",
	taskPlacement: null,
} as AgentSessionRecord;
const machines = {
	ensureRunning: vi.fn(async () => undefined),
	readTextFile: vi.fn(async () => "/workspace/repo"),
} as unknown as WorkspaceMachines;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.root.mockImplementation(async () => ({
		session: root,
		providerRef: "vm-root",
	}));
	mocks.child.mockImplementation(async (_machines, input) => ({
		session: input.task,
		providerRef: input.task.taskPlacement === "shared" ? "vm-root" : "vm-child",
	}));
});

it("does not bind until a repository tool asks, and shares concurrent preparation", async () => {
	const prepare = deferredApiTurnWorkspace(
		machines,
		root,
		new AbortController().signal,
	);
	expect(mocks.root).not.toHaveBeenCalled();
	const [first, second] = await Promise.all([prepare(), prepare()]);
	expect(first).toBe(second);
	expect(mocks.root).toHaveBeenCalledTimes(1);
});

it("prepares a cold shared parent before binding the child to that exact workspace", async () => {
	mocks.read.mockResolvedValue(root);
	const task = {
		...root,
		id: "child",
		taskPlacement: "shared",
		parentSessionId: root.id,
	} as AgentSessionRecord;
	const binding = await deferredApiTurnWorkspace(
		machines,
		task,
		new AbortController().signal,
	)();
	expect(binding.vm).toBe("vm-root");
	expect(mocks.root).toHaveBeenCalledTimes(1);
	expect(mocks.child).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ task }),
	);
	expect(mocks.checkout).toHaveBeenCalledTimes(1);
});

it("preserves the validated stacked predecessor when lazily binding a writer", async () => {
	const predecessor = {
		...root,
		id: "previous",
		taskBranch: "ytimesy/previous",
	};
	mocks.read.mockResolvedValue(predecessor);
	const task = {
		...root,
		id: "child",
		taskPlacement: "fresh",
		taskExecution: "stacked",
		dependsOnSessionId: predecessor.id,
	} as AgentSessionRecord;
	await deferredApiTurnWorkspace(
		machines,
		task,
		new AbortController().signal,
	)();
	expect(mocks.root).not.toHaveBeenCalled();
	expect(mocks.child).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ task, predecessor }),
	);
});

it("rejects cancelled preparation and cross-project shared parents", async () => {
	const controller = new AbortController();
	controller.abort();
	expect(() =>
		deferredApiTurnWorkspace(machines, root, controller.signal)(),
	).toThrow();
	mocks.read.mockResolvedValue({ ...root, projectId: "other" });
	await expect(
		deferredApiTurnWorkspace(
			machines,
			{
				...root,
				id: "child",
				taskPlacement: "shared",
				parentSessionId: root.id,
			} as AgentSessionRecord,
			new AbortController().signal,
		)(),
	).rejects.toThrow("shared parent");
	expect(mocks.child).not.toHaveBeenCalled();
});
