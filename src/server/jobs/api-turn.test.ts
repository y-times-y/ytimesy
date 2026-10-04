import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import type { ApiTurn } from "../adapters/api-turns";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const fixture = vi.hoisted(() => ({
	commit: vi.fn(),
	finish: vi.fn(),
	order: [] as string[],
}));
const owner = {
	id: "chat",
	userId: "alice",
	projectId: "project",
	providerRef: "executor",
	parentSessionId: null,
	taskPlacement: "fresh",
	taskAccess: "read_write",
	harness: "api",
} as AgentSessionRecord;
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: async () => owner,
}));
vi.mock("../adapters/api-turns", () => ({
	renewApiTurn: async () => true,
	checkpointApiTurn: vi.fn(),
	finishApiTurn: fixture.finish,
}));
vi.mock("../adapters/model-connections", () => ({
	loadModelConnection: async () => ({ revision: 1 }),
}));
vi.mock("../services/agent-session-machine", () => ({
	bindAgentSessionMachine: async () => ({
		session: owner,
		providerRef: "executor",
	}),
}));
vi.mock("../services/project-workspace", () => ({
	loadTenantProjectCheckout: () => Effect.succeed(null),
	ensureProjectCheckout: () => Effect.void,
}));
vi.mock("../services/api-agent-tools", () => ({ apiAgentTools: () => ({}) }));
vi.mock("../services/api-agent-runtime", () => ({
	runApiAgent: async () => fixture.order.push("model"),
}));
vi.mock("../services/turn-commit", () => ({
	commitCompletedSessionTurn: fixture.commit,
}));

it.each([false, true])(
	"finishes API turns only after commit succeeds; commit failure=%s",
	async (fails) => {
		fixture.order.length = 0;
		fixture.commit.mockReset().mockImplementation(async () => {
			fixture.order.push("commit");
			if (fails) throw new Error("Git hook rejected the commit");
		});
		fixture.finish.mockReset().mockImplementation(async (_turn, state) => {
			fixture.order.push(state);
			return true;
		});
		const writes: string[] = [];
		const machines = {
			ensureRunning: async () => "executor",
			readTextFile: async () => "/home/ubuntu/repo",
			writeTextFile: async (_id: string, _path: string, contents: string) => {
				writes.push(contents);
			},
		} as unknown as WorkspaceMachines;
		await runApiTurn(machines, {
			id: "turn",
			user_id: "alice",
			session_id: "chat",
			connection_id: "connection",
			connection_revision: 1,
			model_id: "model",
			items: [],
			messages: [],
		} as unknown as ApiTurn);
		expect(fixture.order).toEqual([
			"model",
			"commit",
			fails ? "failed" : "completed",
		]);
		expect(fixture.commit.mock.calls[0][0].providerRef).toBe("executor");
		if (fails) {
			expect(writes.at(-1)).toContain("automatic Git handoff failed");
			expect(writes.at(-1)).not.toContain('"turnStatus":"completed"');
		}
	},
);
