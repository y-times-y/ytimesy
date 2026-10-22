import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { sendHarnessWorkspaceTask } from "#/server/services/harness-workspace-session";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const fake = vi.hoisted(() => ({
	owner: vi.fn(),
	send: vi.fn(),
	select: vi.fn(),
	commit: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: fake.owner,
	claimChatForSend: vi.fn(async () => false),
	releaseChatClaim: vi.fn(async () => {}),
	selectAgentSessionHarness: fake.select,
}));
vi.mock("#/server/services/session-branch", () => ({
	commitChatBranchForSubmission: fake.commit,
}));
vi.mock("#/server/services/codex-subscription-session", () => ({
	sendSubscriptionTask: fake.send,
}));

const scope = {
	userId: "owner",
	projectId: "project",
	sessionId: "session",
	harnessId: "codex" as const,
};
beforeEach(() => {
	vi.clearAllMocks();
	fake.send.mockResolvedValue({ items: [] });
	fake.select.mockResolvedValue(undefined);
});

it("switching back to a subscription model sends the request, with the envelope only as a fallback", async () => {
	fake.owner.mockResolvedValue({
		id: "session",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [
			{ kind: "userMessage", id: "u1", text: "run the marker command" },
			{ kind: "agentMessage", id: "a1", text: "Ran it." },
		],
	});
	await Effect.runPromise(
		sendHarnessWorkspaceTask({} as WorkspaceMachines, scope, {
			text: "what did you run last?",
			modelId: "gpt-5.5",
		}),
	);
	expect(fake.select).toHaveBeenCalledWith(
		"owner",
		"project",
		"session",
		"codex",
	);
	expect(fake.send).toHaveBeenCalledTimes(1);
	const [, input] = fake.send.mock.calls[0];
	// Structured history carries the conversation; the request goes as written.
	expect(input.runtimeText).toBe("what did you run last?");
	expect(input.runtimeHandoff).toContain("<previous-conversation>");
	expect(input.runtimeHandoff).toContain("run the marker command");
});

it("adds no envelope when the runtime does not change", async () => {
	fake.owner.mockResolvedValue({
		id: "session",
		projectId: "project",
		harness: "codex",
		turnStatus: "idle",
		items: [],
	});
	await Effect.runPromise(
		sendHarnessWorkspaceTask({} as WorkspaceMachines, scope, {
			text: "next",
			modelId: "gpt-5.5",
		}),
	);
	const [, input] = fake.send.mock.calls[0];
	expect(input.runtimeText).toBe("next");
	expect(input.runtimeHandoff).toBeUndefined();
	expect(fake.select).not.toHaveBeenCalled();
});

it("sends from the chat it read and its branch commit wrote, reading it once", async () => {
	const read = {
		id: "session",
		projectId: "project",
		harness: "codex",
		turnStatus: "idle",
		items: [],
	};
	const committed = { ...read, workingBranch: "ytimesy/next-session" };
	fake.owner.mockResolvedValue(read);
	fake.commit.mockResolvedValue(committed);
	await Effect.runPromise(
		sendHarnessWorkspaceTask({} as WorkspaceMachines, scope, {
			text: "next",
			modelId: "gpt-5.5",
		}),
	);
	expect(fake.owner).toHaveBeenCalledOnce();
	expect(fake.commit).toHaveBeenCalledWith(
		expect.objectContaining({ sessionId: "session", session: read }),
	);
	expect(fake.send).toHaveBeenCalledWith(
		scope,
		expect.objectContaining({ runtimeText: "next" }),
		false,
		committed,
	);
});
