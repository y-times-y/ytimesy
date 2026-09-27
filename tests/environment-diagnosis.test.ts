import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { REMOVE_CODEX_CREDENTIAL_FILES } from "../src/server/adapters/codex/credential-files";
import { diagnoseEnvironmentFailure } from "../src/server/adapters/codex/environment-diagnosis";

const mocks = vi.hoisted(() => ({
	hasAuth: vi.fn(),
	tokens: vi.fn(),
	configure: vi.fn(),
	submit: vi.fn(),
	read: vi.fn(),
	stop: vi.fn(),
	exec: vi.fn(),
	write: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
vi.mock("../src/server/auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: mocks.hasAuth,
	codexExternalTokens: mocks.tokens,
}));
vi.mock("../src/server/adapters/freestyle/workspace-machines", () => ({
	createFreestyleWorkspaceMachines: () => ({
		exec: mocks.exec,
		writeTextFile: mocks.write,
	}),
}));
vi.mock("../src/server/adapters/codex/login-session", () => ({
	configureCodexExternalAuth: mocks.configure,
	submitCodexTask: mocks.submit,
	readLoginStatus: mocks.read,
	stopCodexLoginDaemon: mocks.stop,
}));
const input = {
	modelId: "listed-model",
	userId: "alice",
	vm: "vm-builder",
	directory: "/home/ubuntu/repo",
	failure: { exitCode: 1, stdout: "secret-value missing gcc", stderr: "" },
	secrets: { TOKEN: "secret-value" },
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("FREESTYLE_API_KEY", "test-key");
	mocks.hasAuth.mockResolvedValue(true);
	mocks.tokens.mockResolvedValue({ accessToken: "token" });
	mocks.configure.mockReturnValue(
		Effect.succeed({
			stage: "authenticated",
			models: [{ id: "listed-model" }],
			turn: null,
		}),
	);
	mocks.submit.mockReturnValue(Effect.succeed({ stage: "authenticated" }));
	mocks.read.mockReturnValue(
		Effect.succeed({
			stage: "authenticated",
			turnStatus: "idle",
			turn: { status: "completed", text: '{"action":"retry-install"}' },
		}),
	);
	mocks.stop.mockReturnValue(Effect.void);
	mocks.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
	mocks.write.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
it("uses syntactically valid shell for credential cleanup", () => {
	const result = spawnSync("bash", ["-n"], {
		input: REMOVE_CODEX_CREDENTIAL_FILES,
		encoding: "utf8",
	});
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});
it("uses listed subscription model in isolated read-only diagnosis mode and cleans credentials", async () => {
	await expect(diagnoseEnvironmentFailure(input)).resolves.toEqual({
		action: "retry-install",
	});
	expect(mocks.configure.mock.calls[0][3]).toEqual({ diagnosisOnly: true });
	const request = mocks.submit.mock.calls[0][2];
	expect(request.readOnly).toBe(true);
	expect(request.modelId).toBe("listed-model");
	expect(request.text).not.toContain("secret-value");
	expect(request.text).toContain("[REDACTED]");
	expect(mocks.stop).toHaveBeenCalledOnce();
	expect(mocks.exec.mock.calls[0][1]).toContain(
		"ytimesy-codex-external-tokens.json",
	);
});
it("does not fall back to an API without a Codex connection", async () => {
	mocks.hasAuth.mockResolvedValue(false);
	await expect(diagnoseEnvironmentFailure(input)).rejects.toThrow(
		"Connect Codex",
	);
	expect(mocks.configure).not.toHaveBeenCalled();
});
it("cleans up after invalid model output and never returns shell commands", async () => {
	mocks.read.mockReturnValue(
		Effect.succeed({
			stage: "authenticated",
			turnStatus: "idle",
			turn: {
				status: "completed",
				text: '{"action":"shell","command":"unsafe"}',
			},
		}),
	);
	await expect(diagnoseEnvironmentFailure(input)).rejects.toThrow(
		"unsupported repair",
	);
	expect(mocks.stop).toHaveBeenCalledOnce();
});
it("blocks continuation if credential cleanup fails", async () => {
	mocks.exec.mockResolvedValue({ exitCode: 1 });
	await expect(diagnoseEnvironmentFailure(input)).rejects.toThrow(
		"activation is blocked",
	);
});
