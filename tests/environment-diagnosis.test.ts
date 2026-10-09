import { beforeEach, expect, it, vi } from "vitest";
import { diagnoseEnvironmentFailure } from "../src/server/adapters/codex/environment-diagnosis";

const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	model: vi.fn(),
	run: vi.fn(),
}));
vi.mock("../src/server/auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: mocks.auth,
}));
vi.mock("../src/server/adapters/codex-subscription", () => ({
	codexSubscriptionModel: mocks.model,
}));
vi.mock("../src/server/services/model-agent-loop", () => ({
	runModelAgent: mocks.run,
}));
const input = {
	userId: "alice",
	modelId: "listed-model",
	vm: "builder",
	directory: "/repo",
	failure: { exitCode: 1, stdout: "private-token missing gcc", stderr: "" },
	secrets: { TOKEN: "private-token" },
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.auth.mockResolvedValue(true);
	mocks.model.mockResolvedValue({ model: "subscription-model" });
	mocks.run.mockImplementation(async (request) =>
		request.onEvent({ type: "text-delta", text: '{"action":"retry-install"}' }),
	);
});
it("uses the selected subscription and shared tool-less loop without VM auth", async () => {
	expect(await diagnoseEnvironmentFailure(input)).toEqual({
		action: "retry-install",
	});
	expect(mocks.model).toHaveBeenCalledWith(
		"alice",
		"listed-model",
		undefined,
		false,
		"environment:builder",
	);
	const request = mocks.run.mock.calls[0][0];
	expect(request).toMatchObject({
		tools: {},
		maxSteps: 1,
		maxOutputTokens: 512,
	});
	expect(request.messages[0].content).not.toContain("private-token");
	expect(request.messages[0].content).toContain("[REDACTED]");
	expect(request.signal).toBeInstanceOf(AbortSignal);
});
it("does not select a fallback without subscription access", async () => {
	mocks.auth.mockResolvedValue(false);
	await expect(diagnoseEnvironmentFailure(input)).rejects.toThrow(
		"Connect Codex",
	);
	expect(mocks.model).not.toHaveBeenCalled();
	expect(mocks.run).not.toHaveBeenCalled();
});
it("rejects arbitrary model-written commands", async () => {
	mocks.run.mockImplementation(async (request) =>
		request.onEvent({
			type: "text-delta",
			text: '{"action":"shell","command":"unsafe"}',
		}),
	);
	await expect(diagnoseEnvironmentFailure(input)).rejects.toThrow(
		"unsupported repair",
	);
});
it("does not hide authentication or inference failures", async () => {
	mocks.run.mockRejectedValue(new Error("subscription unavailable"));
	await expect(diagnoseEnvironmentFailure(input)).rejects.toThrow(
		"subscription unavailable",
	);
	expect(mocks.run).toHaveBeenCalledOnce();
});
