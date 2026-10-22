import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { guestMetadataBlockCommand } from "#/domain/guest-network-guard";
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
	revision: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
	fileAt: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
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
	ensureProjectCheckout: (
		_machines: unknown,
		_vm: unknown,
		checkout: unknown,
	) => {
		mocks.checkout(checkout);
		return Effect.void;
	},
	checkoutGitHubReads: (checkout: unknown) => ({
		baseRevision: () => mocks.revision(checkout),
		fileAt: mocks.fileAt,
	}),
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
	// The cloud metadata block each preparation runs.
	exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
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
	// Every prepared VM refuses cloud metadata (as root) before it is used.
	expect(vi.mocked(machines.exec)).toHaveBeenCalledWith(
		expect.anything(),
		guestMetadataBlockCommand(),
		30_000,
	);
});

it("binds a shared child to its parent's workspace without preparing a checkout", async () => {
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
	expect(mocks.root).not.toHaveBeenCalled();
	expect(mocks.child).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ task }),
	);
	expect(mocks.load).not.toHaveBeenCalled();
	expect(mocks.checkout).not.toHaveBeenCalled();
});

it("fails a shared child clearly when its parent's workspace stays unavailable", async () => {
	vi.useFakeTimers();
	try {
		mocks.read.mockResolvedValue(root);
		mocks.child.mockRejectedValue(
			new Error("Start the parent workspace before sharing its state."),
		);
		const attaching = deferredApiTurnWorkspace(
			machines,
			{
				...root,
				id: "child",
				taskPlacement: "shared",
				parentSessionId: root.id,
				agentRole: "reviewer",
			} as AgentSessionRecord,
			new AbortController().signal,
		)();
		const failed = expect(attaching).rejects.toThrow(
			/parent's workspace is unavailable.*Start the parent workspace/,
		);
		await vi.runAllTimersAsync();
		await failed;
		expect(mocks.checkout).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
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

describe("a new chat's pinned base", () => {
	const fresh = {
		owner: "acme",
		name: "app",
		fullName: "acme/app",
		branch: "main",
		workingBranch: "ytimesy/fix-login-1234",
		installationId: "1",
		preserveCurrentBranch: true,
		retainExistingBranch: false,
	};
	const sha = "b".repeat(40);
	beforeEach(() => {
		mocks.load.mockImplementation(() => Effect.succeed(fresh));
		mocks.revision.mockResolvedValue(sha);
	});

	it("is read before the VM and the checkout lands on it", async () => {
		let bound = () => {};
		mocks.root.mockImplementation(
			() =>
				new Promise((resolve) => {
					bound = () => resolve({ session: root, providerRef: "vm-root" });
				}),
		);
		const prepare = deferredApiTurnWorkspace(
			machines,
			root,
			new AbortController().signal,
			undefined,
			{ pinNewChatBase: true },
		);
		const preparing = prepare();
		// Known while the VM is still being bound.
		expect(await prepare.pinnedBase()).toBe(sha);
		expect(mocks.revision).toHaveBeenCalledWith(fresh);
		bound();
		await preparing;
		expect(mocks.checkout).toHaveBeenCalledWith({
			...fresh,
			pinnedRevision: sha,
		});
	});

	it.each([
		["not asked for", root, {}, fresh],
		[
			"a chat that already has a machine",
			{ ...root, providerRef: "vm-root" } as AgentSessionRecord,
			{ pinNewChatBase: true },
			fresh,
		],
		[
			"a chat on an existing branch",
			root,
			{ pinNewChatBase: true },
			{ ...fresh, workingBranch: "main" },
		],
		[
			"a chat that keeps its legacy checkout",
			root,
			{ pinNewChatBase: true },
			{ ...fresh, retainExistingBranch: true },
		],
	])("is not pinned for %s", async (_case, owner, options, planned) => {
		mocks.load.mockImplementation(() => Effect.succeed(planned));
		const prepare = deferredApiTurnWorkspace(
			machines,
			owner,
			new AbortController().signal,
			undefined,
			options,
		);
		await prepare();
		expect(await prepare.pinnedBase()).toBeNull();
		expect(mocks.revision).not.toHaveBeenCalled();
		expect(mocks.checkout).toHaveBeenCalledWith(planned);
	});

	it("reads a file from GitHub only at the pinned commit", async () => {
		mocks.fileAt.mockResolvedValue({ present: false });
		const prepare = deferredApiTurnWorkspace(
			machines,
			root,
			new AbortController().signal,
			undefined,
			{ pinNewChatBase: true },
		);
		await prepare();
		expect(await prepare.pinnedBaseFile("c".repeat(40), "a.json")).toBeNull();
		expect(mocks.fileAt).not.toHaveBeenCalled();
		expect(await prepare.pinnedBaseFile(sha, "a.json")).toEqual({
			present: false,
		});
		expect(mocks.fileAt).toHaveBeenCalledWith(sha, "a.json");
		mocks.fileAt.mockRejectedValue(new Error("GitHub unavailable"));
		expect(await prepare.pinnedBaseFile(sha, "a.json")).toBeNull();
	});

	it("reads no file when nothing was pinned", async () => {
		const prepare = deferredApiTurnWorkspace(
			machines,
			root,
			new AbortController().signal,
		);
		await prepare();
		expect(await prepare.pinnedBaseFile(sha, "a.json")).toBeNull();
		expect(mocks.fileAt).not.toHaveBeenCalled();
	});

	it("is unknown, and the checkout unpinned, when GitHub cannot say", async () => {
		mocks.revision.mockRejectedValue(new Error("GitHub unavailable"));
		const prepare = deferredApiTurnWorkspace(
			machines,
			root,
			new AbortController().signal,
			undefined,
			{ pinNewChatBase: true },
		);
		await prepare();
		expect(await prepare.pinnedBase()).toBeNull();
		expect(mocks.checkout).toHaveBeenCalledWith(fresh);
	});
});
