import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { startPullRequestReview } from "./pull-request-review-chat";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	holding: vi.fn(),
	allow: vi.fn(),
	open: vi.fn(),
	send: vi.fn(),
}));
vi.mock("../adapters/agent-sessions", () => ({
	chatHoldingSend: mocks.holding,
}));
vi.mock("../adapters/user-action-rate", () => ({
	requireUserAction: mocks.allow,
}));
vi.mock("./agent-session-machine", () => ({ openAgentSession: mocks.open }));
vi.mock("./queued-user-messages", () => ({ sendComposerMessage: mocks.send }));

const machines = {} as WorkspaceMachines;
const review = {
	userId: "alice",
	projectId: "11111111-1111-4111-8111-111111111111",
	harnessId: "codex" as const,
	modelId: "gpt-5",
	requestId: "22222222-2222-4222-8222-222222222222",
	fullName: "acme/app",
	number: 12,
	title: "Add parser",
	url: "https://github.com/acme/app/pull/12",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.holding.mockResolvedValue(null);
	mocks.allow.mockResolvedValue(undefined);
	mocks.open.mockResolvedValue({
		id: "new-chat",
		harness: "codex",
		listedModelId: "gpt-5",
	});
	mocks.send.mockReturnValue(
		Effect.succeed({ connection: { status: "authenticated" } }),
	);
});

it("opens a new chat and sends the review there instead of an existing one", async () => {
	await expect(startPullRequestReview(machines, review)).resolves.toEqual({
		sessionId: "new-chat",
	});
	expect(mocks.open).toHaveBeenCalledWith({
		userId: "alice",
		projectId: review.projectId,
		harness: "codex",
		title: "Review PR #12",
	});
	expect(mocks.open.mock.calls[0]?.[0]).not.toHaveProperty("sessionId");
	const scope = mocks.send.mock.calls[0]?.[1];
	expect(scope).toMatchObject({
		sessionId: "new-chat",
		createNew: false,
		projectId: review.projectId,
	});
	expect(scope.sessionId).not.toBe(review.projectId);
	const text = mocks.send.mock.calls[0]?.[2].text as string;
	expect(text).toContain('Review pull request #12 "Add parser" in acme/app');
	expect(text).toContain("https://github.com/acme/app/pull/12");
	expect(text).toContain("Read the diff and comment on issues.");
	expect(mocks.send.mock.calls[0]?.[2].idempotencyKey).toBe(review.requestId);
});

it("returns the chat that already accepted this review without sending again", async () => {
	mocks.holding.mockResolvedValue("already-chat");
	await expect(startPullRequestReview(machines, review)).resolves.toEqual({
		sessionId: "already-chat",
	});
	expect(mocks.open).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
});

it("does not send when no model is selected", async () => {
	mocks.open.mockResolvedValue({
		id: "new-chat",
		harness: "codex",
		listedModelId: null,
	});
	await expect(
		startPullRequestReview(machines, { ...review, modelId: "  " }),
	).rejects.toThrow(/Select a model/);
	expect(mocks.send).not.toHaveBeenCalled();
});
