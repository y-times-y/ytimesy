import { expect, it, vi } from "vitest";
import { runNativeCodexEvaluation } from "../benchmarks/evaluation/native-codex";
import type {
	EvaluationProtocol,
	EvaluationTask,
} from "../src/domain/harness-evaluation";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

const mocks = vi.hoisted(() => ({ destroy: vi.fn(), bind: vi.fn() }));
vi.mock("../src/server/services/agent-session-machine", () => ({
	openAgentSession: async () => ({
		id: "11111111-1111-4111-8111-111111111111",
	}),
	deleteAgentSessionMachine: mocks.destroy,
}));
vi.mock("../src/server/adapters/agent-sessions", () => ({
	saveAgentSessionProviderRef: mocks.bind,
}));
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async () => ({ rows: [{ encrypted_codex_auth: "fixture" }] }),
	}),
}));
vi.mock("../src/server/auth/token-vault", () => ({
	unseal: async () =>
		JSON.stringify({ tokens: { id_token: "fixture-identity" } }),
}));
vi.mock("../src/server/auth/codex-managed-auth", () => ({
	codexExternalTokens: async () => ({
		accessToken: "fixture-token",
		chatgptAccountId: "fixture-account",
	}),
	codexAccessTokenExpiresAt: () => Date.now() + 3_600_000,
}));
vi.mock("../benchmarks/evaluation/production", () => ({
	evaluationPatchScript: () => "export-patch",
}));

it("keeps native credentials isolated without breaking the prepared home and package cache", async () => {
	const commit = "a".repeat(40);
	const execute = vi
		.fn()
		.mockResolvedValueOnce({ exitCode: 0, stdout: `${commit}\n`, stderr: "" })
		.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
		.mockResolvedValueOnce({ exitCode: 0, stdout: "0", stderr: "" })
		.mockResolvedValueOnce({ exitCode: 0, stdout: "patch", stderr: "" });
	const machines = {
		provisionSession: async () => "native-vm",
		exec: execute,
		writeTextFile: vi.fn(),
		readTextFile: async () => "",
	} as unknown as WorkspaceMachines;
	const result = await runNativeCodexEvaluation({
		machines,
		userId: "owner",
		snapshotId: "snapshot",
		task: {
			id: "task",
			projectId: "project",
			commit,
			prompt: "Implement the task",
		} as EvaluationTask,
		protocol: {
			modelId: "gpt-6.1-sol",
			reasoning: "medium",
			limits: { durationSeconds: 600 },
		} as EvaluationProtocol,
	});
	const launch = execute.mock.calls[1][1];
	expect(launch).toContain("export HOME=/home/ubuntu\n");
	expect(launch).toContain("--sandbox danger-full-access");
	expect(launch).not.toContain("--sandbox workspace-write");
	expect(launch).toMatch(
		/export CODEX_HOME='\/home\/ubuntu\/\.ytimesy-native-evaluation-[^']+'/,
	);
	expect(launch).not.toContain(
		"export HOME='/home/ubuntu/.ytimesy-native-evaluation-",
	);
	expect(result.exitCode).toBe(0);
	expect(result.executionIsolation).toBe("disposable-vm");
	expect(mocks.destroy).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({
			sessionId: "11111111-1111-4111-8111-111111111111",
		}),
	);
});
