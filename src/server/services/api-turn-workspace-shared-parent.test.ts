import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { deferredApiTurnWorkspace } from "./api-turn-workspace";
import type { WorkspaceMachines } from "./workspace-machines";

// The real ensureProjectCheckout runs; only its GitHub edge is replaced by
// the failure a host without GitHub App credentials gives.
const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	root: vi.fn(),
	child: vi.fn(),
	broker: vi.fn(async () => {
		throw new Error(
			"GITHUB_APP_ID and GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH are required",
		);
	}),
}));
vi.mock("./verification-baseline", () => ({
	establishVerificationBaselines: async () => {},
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.read,
	agentSessionMetadataForOwner: mocks.read,
}));
vi.mock("./agent-session-machine", () => ({
	bindAgentSessionMachine: mocks.root,
	bindPreparedAgentTaskMachine: mocks.child,
}));
vi.mock("./session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));
vi.mock("#/server/adapters/github/git-broker", () => ({
	receiveBrokeredRepository: mocks.broker,
}));
vi.mock("#/server/adapters/github", () => ({ authorizedRepository: vi.fn() }));
vi.mock("#/server/adapters/projects", () => ({
	listProjects: vi.fn(),
	projectForOwner: vi.fn(),
}));
vi.mock("#/server/auth/github-connection", () => ({
	githubAccessToken: vi.fn(),
}));
vi.mock("./project-workspace", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project-workspace")>()),
	loadTenantProjectCheckout: () =>
		Effect.succeed({
			name: "repo",
			workingBranch: "main",
			preserveCurrentBranch: true,
			retainExistingBranch: false,
			additionalRepositories: [],
		}),
}));

const root = {
	id: "root",
	userId: "owner",
	projectId: "project",
	harness: "codex",
	taskPlacement: null,
	parentSessionId: null,
	providerRef: "vm-root",
} as unknown as AgentSessionRecord;
const reader = {
	...root,
	id: "reader",
	parentSessionId: root.id,
	taskPlacement: "shared",
	taskAccess: "read_only",
	agentRole: "researcher",
	providerRef: null,
} as unknown as AgentSessionRecord;

/**
 * The parent's VM as a provider shows it while a writer's fork snapshots
 * it: paused, so commands fail and files read as missing.
 */
function parentVm() {
	let paused = false;
	let touchedWhilePaused: () => void = () => {};
	const touched = new Promise<void>((resolve) => {
		touchedWhilePaused = resolve;
	});
	const machines = {
		ensureRunning: vi.fn(async (vm: string) => vm),
		exec: vi.fn(async (_vm: string, command: string) => {
			if (paused) {
				touchedWhilePaused();
				return { exitCode: 1, stdout: "", stderr: "container is paused" };
			}
			if (command.includes("echo present"))
				return {
					exitCode: 0,
					stdout: "present\n/home/ubuntu/repo\n",
					stderr: "",
				};
			if (command.includes("branch --show-current"))
				return { exitCode: 0, stdout: "main\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		}),
		readTextFile: vi.fn(async () => {
			if (paused) {
				touchedWhilePaused();
				return null;
			}
			return "/home/ubuntu/repo\n";
		}),
		writeTextFile: vi.fn(async () => {
			if (paused) throw new Error("container is paused");
		}),
	} as unknown as WorkspaceMachines;
	return {
		machines,
		/** A writer's fork: pauses the parent until the reader has tried it. */
		fork: async () => {
			paused = true;
			await touched;
			await new Promise((resolve) => setTimeout(resolve, 20));
			paused = false;
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.read.mockImplementation(async (_user: string, id: string) =>
		id === root.id ? root : null,
	);
	mocks.root.mockImplementation(async () => ({
		session: root,
		providerRef: "vm-root",
	}));
	mocks.child.mockImplementation(async (_machines, input) => ({
		session: { ...input.task, providerRef: "vm-root" },
		providerRef: "vm-root",
	}));
});

it("attaches a reader started beside a writer's fork to the parent's VM without preparing a repository", async () => {
	const vm = parentVm();
	const [, attached] = await Promise.all([
		vm.fork(),
		deferredApiTurnWorkspace(
			vm.machines,
			reader,
			new AbortController().signal,
		)(),
	]);
	expect(attached).toMatchObject({ vm: "vm-root", cwd: "/home/ubuntu/repo" });
	expect(mocks.broker).not.toHaveBeenCalled();
	expect(mocks.root).not.toHaveBeenCalled();
});

it("never prepares the parent's repository for a reader, even when the parent is idle", async () => {
	const vm = parentVm();
	await deferredApiTurnWorkspace(
		vm.machines,
		reader,
		new AbortController().signal,
	)();
	expect(mocks.root).not.toHaveBeenCalled();
	expect(mocks.broker).not.toHaveBeenCalled();
	expect(vm.machines.exec).not.toHaveBeenCalled();
});
