import { afterEach, describe, expect, it, vi } from "vitest";
import {
	agentSessionForOwner,
	sideAgentSession,
} from "../adapters/agent-sessions";
import { watchSessionProgress } from "../adapters/freestyle/session-progress";
import { sessionProgressResponse } from "./session-progress";

vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: vi.fn(),
	sideAgentSession: vi.fn(),
}));
vi.mock("../adapters/freestyle/session-progress", () => ({
	watchSessionProgress: vi.fn(),
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
	providerRef: "vm",
	harness: "codex",
	taskPlacement: "fresh",
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

describe("private session progress", () => {
	it("resolves side chat ownership before selecting its runtime", async () => {
		vi.stubEnv("FREESTYLE_API_KEY", "fixture");
		mockSession(record);
		vi.mocked(sideAgentSession).mockResolvedValue({
			...record,
			id: "child",
			harness: "claude",
		} as Awaited<ReturnType<typeof sideAgentSession>>);
		vi.mocked(watchSessionProgress).mockResolvedValue(vi.fn());
		const response = await sessionProgressResponse({ ...scope, lane: "side" });
		expect(sideAgentSession).toHaveBeenCalledWith("owner", "session");
		expect(
			vi.mocked(watchSessionProgress).mock.calls[0][0].paths.output,
		).toContain("claude-turn.out");
		await response.body?.cancel();
	});
	it("rejects missing ownership and cross-project access before opening a VM stream", async () => {
		mockSession(null);
		expect((await sessionProgressResponse(scope)).status).toBe(404);
		mockSession({ ...record, projectId: "another" });
		expect((await sessionProgressResponse(scope)).status).toBe(404);
		expect(watchSessionProgress).not.toHaveBeenCalled();
		expect(agentSessionForOwner).toHaveBeenCalledWith("owner", "session");
	});
	it("streams before completion, deduplicates snapshots and closes only the reader on cancellation", async () => {
		vi.stubEnv("FREESTYLE_API_KEY", "fixture");
		mockSession(record);
		const close = vi.fn();
		vi.mocked(watchSessionProgress).mockResolvedValue(close);
		const response = await sessionProgressResponse(scope);
		if (!response.body) throw new Error("Missing event stream");
		const reader = response.body.getReader();
		await reader.read();
		const input = vi.mocked(watchSessionProgress).mock.calls[0][0];
		const files = {
			status: JSON.stringify({
				stage: "authenticated",
				turnStatus: "running",
				items: [{ type: "agentMessage", id: "a", text: "Hello" }],
			}),
		};
		input.onFiles(files);
		input.onFiles(files);
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain('"text":"Hello"');
		expect(first).toContain('"turnStatus":"running"');
		input.onFiles({ status: files.status.replace("Hello", "Hello world") });
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			"Hello world",
		);
		await reader.cancel();
		expect(input.signal.aborted).toBe(true);
		expect(close).toHaveBeenCalled();
	});
	it("uses separate runtime files for a shared child", async () => {
		vi.stubEnv("FREESTYLE_API_KEY", "fixture");
		mockSession({ ...record, taskPlacement: "shared" });
		vi.mocked(watchSessionProgress).mockResolvedValue(vi.fn());
		const response = await sessionProgressResponse(scope);
		expect(vi.mocked(watchSessionProgress).mock.calls[0][0].paths.status).toBe(
			"/tmp/ytimesy-sessions/session/ytimesy-auth-status.json",
		);
		await response.body?.cancel();
	});
});
