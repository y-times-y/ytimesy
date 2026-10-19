import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { deferredApiTurnWorkspace } from "./api-turn-workspace";
import { turnWorkspaceReuse } from "./turn-workspace-reuse";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	root: vi.fn(),
	child: vi.fn(),
	checkout: vi.fn(),
	baseline: vi.fn(async () => {}),
	load: vi.fn(() => Effect.succeed({}) as Effect.Effect<object, Error>),
}));
vi.mock("./verification-baseline", () => ({
	establishVerificationBaselines: mocks.baseline,
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
	loadTenantProjectCheckout: () => mocks.load(),
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
	mocks.load.mockImplementation(() => Effect.succeed({}));
	mocks.root.mockImplementation(async () => ({
		session: root,
		providerRef: "vm-root",
	}));
	mocks.child.mockImplementation(async (_machines, input) => ({
		session: input.task,
		providerRef:
			input.task.agentRole && input.task.agentRole !== "writer"
				? "vm-root"
				: "vm-child",
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
		agentRole: "researcher",
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
				agentRole: "reviewer",
			} as AgentSessionRecord,
			new AbortController().signal,
		)(),
	).rejects.toThrow("shared parent");
	expect(mocks.child).not.toHaveBeenCalled();
});

it("reuses a turn's preparation in its next step until the turn forgets it", async () => {
	const reuse = turnWorkspaceReuse(`turn-${Math.random()}:lease`);
	const step = () =>
		deferredApiTurnWorkspace(
			machines,
			root,
			new AbortController().signal,
			[],
			reuse,
		)();
	const first = await step();
	const second = await step();
	expect(second).toEqual(first);
	expect(mocks.root).toHaveBeenCalledTimes(1);
	expect(mocks.checkout).toHaveBeenCalledTimes(1);
	expect(mocks.baseline).toHaveBeenCalledTimes(1);
	expect(machines.readTextFile).toHaveBeenCalledTimes(1);
	reuse.forget();
	expect(reuse.read()).toBeUndefined();
	await step();
	expect(mocks.root).toHaveBeenCalledTimes(2);
});

it("does not keep a failed preparation for the next step", async () => {
	const reuse = turnWorkspaceReuse(`turn-${Math.random()}:lease`);
	mocks.root.mockRejectedValueOnce(new Error("bind failed"));
	const step = () =>
		deferredApiTurnWorkspace(
			machines,
			root,
			new AbortController().signal,
			[],
			reuse,
		)();
	await expect(step()).rejects.toThrow("bind failed");
	expect(reuse.read()).toBeUndefined();
	await step();
	expect(mocks.root).toHaveBeenCalledTimes(2);
});

it("loads a root chat's checkout plan while its VM is bound, and fails where it used to", async () => {
	const order: string[] = [];
	mocks.load.mockImplementation(() =>
		Effect.sync(() => {
			order.push("checkout");
			return {};
		}),
	);
	let release = () => {};
	mocks.root.mockImplementation(async () => {
		order.push("bind");
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { session: root, providerRef: "vm-root" };
	});
	const preparing = deferredApiTurnWorkspace(
		machines,
		root,
		new AbortController().signal,
	)();
	await vi.waitFor(() => expect(order).toEqual(["checkout", "bind"]));
	release();
	await preparing;
	expect(mocks.checkout).toHaveBeenCalledOnce();

	mocks.load.mockImplementation(() =>
		Effect.fail(new Error("Repository access is unavailable.")),
	);
	mocks.root.mockImplementation(async () => {
		throw new Error("bind failed");
	});
	await expect(
		deferredApiTurnWorkspace(machines, root, new AbortController().signal)(),
	).rejects.toThrow("bind failed");
	mocks.root.mockImplementation(async () => ({
		session: root,
		providerRef: "vm-root",
	}));
	await expect(
		deferredApiTurnWorkspace(machines, root, new AbortController().signal)(),
	).rejects.toThrow("Repository access is unavailable.");
});

it("keeps a root chat working when its already-edited checkout cannot pin a baseline", async () => {
	mocks.baseline.mockRejectedValueOnce(
		new Error("A pristine server-owned verification baseline is required"),
	);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const binding = await deferredApiTurnWorkspace(
		machines,
		root,
		new AbortController().signal,
	)();
	expect(binding.vm).toBe("vm-root");
	expect(mocks.baseline).toHaveBeenCalledTimes(1);
	warn.mockRestore();
});

it("still requires the baseline for a writer subagent", async () => {
	mocks.baseline.mockRejectedValueOnce(new Error("not pristine"));
	mocks.read.mockResolvedValue(root);
	await expect(
		deferredApiTurnWorkspace(
			machines,
			{
				...root,
				id: "writer",
				parentSessionId: root.id,
				taskPlacement: "fresh",
				taskAccess: "read_write",
				agentRole: "writer",
			} as AgentSessionRecord,
			new AbortController().signal,
		)(),
	).rejects.toThrow("not pristine");
});
