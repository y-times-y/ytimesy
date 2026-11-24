import { beforeEach, expect, it, vi } from "vitest";
import { claudeCodeTurnRevision } from "#/domain/claude-code-route";

const mocks = vi.hoisted(() => ({
	preferences: vi.fn(),
	spent: vi.fn(),
	last: vi.fn(),
	connections: vi.fn(),
	claude: vi.fn(),
	codexAuth: vi.fn(),
	codexCatalog: vi.fn(),
}));
vi.mock("../adapters/model-failover-preferences", () => ({
	loadModelFailoverPreferences: mocks.preferences,
}));
vi.mock("../adapters/plan-spent", () => ({
	planSpentUntil: mocks.spent,
	lastSettledTurnFailover: mocks.last,
}));
vi.mock("../adapters/model-connections", () => ({
	listModelConnections: mocks.connections,
}));
vi.mock("../adapters/claude-subscription", () => ({
	hasClaudeSubscription: mocks.claude,
}));
vi.mock("../auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: mocks.codexAuth,
}));
vi.mock("../adapters/codex-subscription", () => ({
	codexSubscriptionCatalog: mocks.codexCatalog,
}));

const { stickyTurnFailover } = await import("./model-failover");
const { routeKey } = await import("#/domain/model-failover");

const claude = {
	connectionId: null,
	connectionRevision: claudeCodeTurnRevision(),
	modelId: "claude-opus-5-5",
};

beforeEach(() => {
	mocks.preferences.mockResolvedValue({
		enabled: true,
		askBeforePaid: false,
		connectionOrder: [],
	});
	mocks.connections.mockResolvedValue([]);
	mocks.claude.mockResolvedValue(true);
	mocks.codexAuth.mockResolvedValue(true);
	mocks.codexCatalog.mockResolvedValue([
		{ id: "gpt-6.2-sol", label: "GPT-6.2-Sol" },
	]);
	mocks.spent.mockResolvedValue(Date.now() + 3_600_000);
});

async function lastTurnMovedTo(modelId: string) {
	const { failoverCandidates } = await import("#/domain/model-failover");
	const { failoverConnections } = await import("./model-failover");
	const target = failoverCandidates({
		original: claude,
		connections: await failoverConnections("user"),
		tried: [routeKey(claude)],
	}).find((row) => row.route.modelId === modelId);
	if (!target) throw new Error("no such fallback");
	return {
		route: target.route,
		label: { model: target.modelLabel, connection: target.connectionLabel },
		tried: [routeKey(claude), routeKey(target.route)],
		triedLabels: ["a", "b"],
		switches: 1,
	};
}

it("starts a chat's next turn on the fallback its last turn moved to while the Claude plan is spent", async () => {
	mocks.last.mockResolvedValue(await lastTurnMovedTo("gpt-6.2-sol"));
	const failover = await stickyTurnFailover("user", "session", claude);
	expect(failover?.route.modelId).toBe("gpt-6.2-sol");
	expect(failover?.tried).toContain(routeKey(claude));
});

it("starts on the chosen model when failover is off, the plan reset, or nothing moved", async () => {
	mocks.last.mockResolvedValue(await lastTurnMovedTo("gpt-6.2-sol"));
	mocks.preferences.mockResolvedValueOnce({
		enabled: false,
		askBeforePaid: false,
		connectionOrder: [],
	});
	expect(await stickyTurnFailover("user", "session", claude)).toBeUndefined();
	mocks.spent.mockResolvedValueOnce(null);
	expect(await stickyTurnFailover("user", "session", claude)).toBeUndefined();
	mocks.last.mockResolvedValue(null);
	expect(await stickyTurnFailover("user", "session", claude)).toBeUndefined();
});

it("never blocks a send: a failing read starts the turn on its route", async () => {
	mocks.spent.mockRejectedValue(new Error("database down"));
	mocks.last.mockResolvedValue(null);
	expect(await stickyTurnFailover("user", "session", claude)).toBeUndefined();
});
