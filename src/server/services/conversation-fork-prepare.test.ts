import { beforeEach, expect, it, vi } from "vitest";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import { prepareForkWorkspace } from "./conversation-recovery";

const mocks = vi.hoisted(() => ({
	bind: vi.fn(),
	fail: vi.fn(),
	startCheckout: vi.fn(),
}));
vi.mock("../adapters/conversation-fork", () => ({
	conversationForkJournal: async () => ({
		journal: {
			state: "preparing",
			attempt: 1,
			sourceSessionId: "source",
			messageId: "m1",
			branch: "ytimesy/fork",
		},
	}),
	bindConversationForkVm: mocks.bind,
	failConversationFork: mocks.fail,
	openConversationForkJournal: vi.fn(),
	retryConversationForkJournal: vi.fn(),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: async () => ({
		id: "source",
		providerRef: "vm-source",
		projectId: "p1",
		turnStatus: "idle",
	}),
	agentSessionItemsOfKindsForOwner: async () => new Map(),
	projectBranchHeldByOtherSession: vi.fn(),
}));
vi.mock("../adapters/conversation-recovery", () => ({
	conversationPoint: async () => ({
		code: { cwd: "/home/ubuntu/app", head: "abc" },
	}),
	conversationPointState: vi.fn(),
	laterConversationCode: vi.fn(),
	saveRecoveredConversation: vi.fn(),
}));
vi.mock("../adapters/project-machine-size", () => ({
	projectMachineSize: async () => undefined,
}));
vi.mock("./conversation-code-checkpoint", () => ({
	assertConversationCodePresent: async () => undefined,
	captureConversationCode: vi.fn(),
	restoreConversationCode: vi.fn(),
	startCheckoutFromConversationCode: mocks.startCheckout,
}));
vi.mock("./session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.bind.mockResolvedValue(true);
});

it("waits for a just-copied machine to show its repository path instead of failing the fork", async () => {
	let forkReads = 0;
	const machines = {
		ensureRunning: vi.fn(async (vm: string) => vm),
		forkWorkspace: vi.fn(async () => ({ vm: "vm-fork" })),
		destroy: vi.fn(async () => undefined),
		exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
		// The copy answers its first read before its files show.
		readTextFile: vi.fn(async (vm: string, path: string) => {
			if (path !== PROJECT_CWD_PATH) return null;
			if (vm === "vm-fork" && forkReads++ === 0) return null;
			return "/home/ubuntu/app\n";
		}),
	};
	await prepareForkWorkspace(machines as never, "user-1", "fork", 1);
	expect(mocks.fail).not.toHaveBeenCalled();
	expect(mocks.startCheckout).toHaveBeenCalledWith(
		expect.objectContaining({ vm: "vm-fork", cwd: "/home/ubuntu/app" }),
		{ cwd: "/home/ubuntu/app", head: "abc" },
		"ytimesy/fork",
	);
	expect(mocks.bind).toHaveBeenCalledWith("user-1", "fork", 1, "vm-fork");
	expect(machines.destroy).not.toHaveBeenCalled();
});
