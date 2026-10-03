import { afterEach, expect, it, vi } from "vitest";
import {
	agentSessionForOwner,
	sideAgentSession,
} from "../adapters/agent-sessions";
import { watchSessionProgress } from "../adapters/freestyle/session-progress";
import { serverSessionProgressResponse } from "./server-session-progress";
import { sessionProgressResponse } from "./session-progress";

vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: vi.fn(),
	sideAgentSession: vi.fn(),
}));
vi.mock("../adapters/freestyle/session-progress", () => ({
	watchSessionProgress: vi.fn(),
}));
vi.mock("./server-session-progress", () => ({
	serverSessionProgressResponse: vi.fn(
		async () => new Response("server stream"),
	),
}));
const scope = {
	userId: "owner",
	projectId: "project",
	sessionId: "session",
	signal: new AbortController().signal,
};
const record = {
	id: "session",
	projectId: "project",
	providerRef: null,
	harness: "codex",
	taskPlacement: "shared",
};
function mockSession(value: object | null) {
	vi.mocked(agentSessionForOwner).mockResolvedValue(
		value as Awaited<ReturnType<typeof agentSessionForOwner>>,
	);
}
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

it.each(["codex", "api"])(
	"streams %s directly from server state without a VM or Freestyle key",
	async (harness) => {
		mockSession({ ...record, harness });
		expect((await sessionProgressResponse(scope)).status).toBe(200);
		expect(serverSessionProgressResponse).toHaveBeenCalledWith({
			userId: "owner",
			sessionId: "session",
			displaySessionId: "session",
			signal: scope.signal,
		});
		expect(watchSessionProgress).not.toHaveBeenCalled();
	},
);
it("rejects missing ownership and cross-project access before opening delivery", async () => {
	mockSession(null);
	expect((await sessionProgressResponse(scope)).status).toBe(404);
	mockSession({ ...record, projectId: "other" });
	expect((await sessionProgressResponse(scope)).status).toBe(404);
	expect(serverSessionProgressResponse).not.toHaveBeenCalled();
});
it("resolves the owned side session before server subscription", async () => {
	mockSession(record);
	vi.mocked(sideAgentSession).mockResolvedValue({
		...record,
		id: "side",
		harness: "api",
	} as Awaited<ReturnType<typeof sideAgentSession>>);
	await sessionProgressResponse({ ...scope, lane: "side" });
	expect(serverSessionProgressResponse).toHaveBeenCalledWith({
		userId: "owner",
		sessionId: "side",
		displaySessionId: "session",
		signal: scope.signal,
	});
});
it("preserves Claude's scoped native-runtime stream", async () => {
	vi.stubEnv("FREESTYLE_API_KEY", "fixture");
	mockSession({ ...record, harness: "claude", providerRef: "vm" });
	vi.mocked(watchSessionProgress).mockResolvedValue(vi.fn());
	const response = await sessionProgressResponse(scope);
	expect(serverSessionProgressResponse).not.toHaveBeenCalled();
	expect(
		vi.mocked(watchSessionProgress).mock.calls[0][0].paths.output,
	).toContain("/tmp/ytimesy-sessions/session/");
	await response.body?.cancel();
});
