import { afterEach, expect, it, vi } from "vitest";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { serverSessionProgressResponse } from "./server-session-progress";
import { sessionProgressResponse } from "./session-progress";

vi.mock("../adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: vi.fn(),
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
	vi.mocked(agentSessionMetadataForOwner).mockResolvedValue(
		value as Awaited<ReturnType<typeof agentSessionMetadataForOwner>>,
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
			signal: scope.signal,
		});
	},
);
it("rejects missing ownership and cross-project access before opening delivery", async () => {
	mockSession(null);
	expect((await sessionProgressResponse(scope)).status).toBe(404);
	mockSession({ ...record, projectId: "other" });
	expect((await sessionProgressResponse(scope)).status).toBe(404);
	expect(serverSessionProgressResponse).not.toHaveBeenCalled();
});
