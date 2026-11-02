import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readApiWorkspaceSession } from "#/server/services/api-workspace-session";

const fake = vi.hoisted(() => ({
	owner: vi.fn(),
	claude: vi.fn(async () => ({ status: "refused" as string })),
	routes: vi.fn(async (): Promise<{ id: string; label: string }[]> => []),
	github: vi.fn(async () => false),
	failover: vi.fn(async () => false),
}));
vi.mock("#/server/adapters/model-failover-preferences", () => ({
	loadModelFailoverPreferences: async () => ({
		enabled: await fake.failover(),
		askBeforePaid: false,
		connectionOrder: [],
	}),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: fake.owner,
	chatHoldingSend: vi.fn(async () => null),
	releasingChatClaimOnFailure: vi.fn(),
	titleUntitledAgentSession: vi.fn(async () => undefined),
	descendantAgentSessions: vi.fn(async () => []),
}));
vi.mock("#/server/adapters/claude-subscription", () => ({
	hasClaudeSubscription: vi.fn(async () => false),
	claudeSubscriptionStatus: fake.claude,
}));
vi.mock("#/server/adapters/model-connections", () => ({
	listModelConnections: vi.fn(async () => []),
	loadModelConnection: vi.fn(),
}));
vi.mock("#/server/services/model-connections", () => ({
	availableApiModelRoutes: fake.routes,
}));
vi.mock("#/server/auth/github-connection", () => ({
	githubConnectionExists: fake.github,
}));

const routeId = "api/0f8fad5b-d9cb-469f-a165-70867728950e/gpt-test";

beforeEach(() => {
	process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED = "1";
	fake.claude.mockResolvedValue({ status: "refused" });
	fake.routes.mockResolvedValue([]);
	fake.github.mockResolvedValue(false);
	fake.failover.mockResolvedValue(false);
});
afterEach(() => {
	delete process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED;
});

it("says why a new chat cannot send: no model, a refused Claude token, no GitHub", async () => {
	const view = await readApiWorkspaceSession({ userId: "u1", projectId: "p1" });
	expect(view.canSend).toBe(false);
	expect(view.sendBlockers).toEqual(["no_model", "claude_token", "github"]);
});

it("names nothing when a model lists and GitHub is connected", async () => {
	fake.claude.mockResolvedValue({ status: "connected" });
	fake.routes.mockResolvedValue([{ id: routeId, label: "Test" }]);
	fake.github.mockResolvedValue(true);
	const view = await readApiWorkspaceSession({ userId: "u1", projectId: "p1" });
	expect(view.canSend).toBe(true);
	expect(view.sendBlockers).toBeUndefined();
});

it("never asks GitHub for a chat already on its branch", async () => {
	fake.routes.mockResolvedValue([{ id: routeId, label: "Test" }]);
	fake.github.mockClear();
	fake.owner.mockResolvedValue({
		id: "s1",
		projectId: "p1",
		items: [{ kind: "userMessage", id: "m1", text: "hi" }],
		turnStatus: "idle",
		harness: "api",
		parentSessionId: null,
		workingBranch: "ytimesy/hi",
	});
	const view = await readApiWorkspaceSession({
		userId: "u1",
		projectId: "p1",
		sessionId: "s1",
	});
	expect(view.sendBlockers).toEqual(["claude_token"]);
	expect(fake.github).not.toHaveBeenCalled();
});

it("keeps the user's Claude model listed while failover can carry its turns", async () => {
	fake.failover.mockResolvedValue(true);
	fake.routes.mockResolvedValue([{ id: routeId, label: "Test" }]);
	fake.github.mockResolvedValue(true);
	fake.owner.mockResolvedValue({
		id: "s1",
		projectId: "p1",
		items: [],
		turnStatus: "idle",
		harness: "api",
		listedModelId: "claude-code/claude-opus-5-5",
	});
	const view = await readApiWorkspaceSession({
		userId: "u1",
		projectId: "p1",
		sessionId: "s1",
	});
	expect(view.models.map((model) => model.id)).toContain(
		"claude-code/claude-opus-5-5",
	);
	expect(view.listedModelId).toBe("claude-code/claude-opus-5-5");
	expect(view.canSend).toBe(true);
});
