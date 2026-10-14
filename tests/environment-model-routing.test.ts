import { beforeEach, expect, it, vi } from "vitest";
import { diagnoseEnvironmentFailure } from "../src/server/services/environment-diagnosis";
import { resolveEnvironmentModel } from "../src/server/services/environment-model";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	auth: vi.fn(),
	run: vi.fn(),
	codex: vi.fn(),
	budget: vi.fn(),
	browse: vi.fn(),
}));
vi.mock("../src/server/adapters/model-connections", () => ({
	loadModelConnection: mocks.load,
}));
vi.mock("../src/server/adapters/browse-models", () => ({
	browseModels: mocks.browse,
}));
vi.mock("../src/server/auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: mocks.auth,
}));
vi.mock("../src/server/services/api-agent-runtime", () => ({
	runApiAgent: mocks.run,
}));
vi.mock("../src/server/adapters/codex/environment-diagnosis", () => ({
	diagnoseEnvironmentFailure: mocks.codex,
}));
vi.mock("../src/server/adapters/api-usage-budget", () => ({
	reserveEnvironmentDiagnosisTokens: mocks.budget,
}));
const id = "00000000-0000-4000-8000-000000000001";
const input = {
	userId: "alice",
	workspaceId: "workspace",
	vm: "builder",
	directory: "/repo",
	failure: { exitCode: 1, stdout: "secret missing gcc", stderr: "" },
	secrets: { TOKEN: "secret" },
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.browse.mockResolvedValue([{ id: "selected-model" }]);
	mocks.run.mockImplementation(async (request) => {
		await request.beforeStep();
		await request.onEvent({
			type: "text-delta",
			text: '{"action":"install-packages","packages":["build-essential"]}',
		});
	});
});
it.each(["openai", "anthropic", "google", "openrouter", "compatible"])(
	"routes the explicitly selected %s model through the shared API harness",
	async (provider) => {
		const modelId =
			provider === "openai"
				? "gpt-6-sol"
				: provider === "anthropic"
					? "claude-opus-5-5"
					: provider === "google"
						? "gemini-3.8-flash"
						: provider === "openrouter"
							? "openai/gpt-6-sol"
							: "grok-4.7";
		mocks.browse.mockResolvedValue([{ id: modelId }]);
		mocks.load.mockResolvedValue({
			id,
			provider,
			revision: "revision",
			// A compatible connection is a maker's own fixed endpoint (here xAI).
			...(provider === "compatible" ? { baseUrl: "https://api.x.ai/v1" } : {}),
			models: [{ id: modelId, label: modelId, toolStreamingVerified: true }],
		});
		const model = await resolveEnvironmentModel("alice", {
			harness: "api",
			modelId: `api/${id}/${encodeURIComponent(modelId)}`,
			allowApi: true,
		});
		await expect(
			diagnoseEnvironmentFailure({ ...input, model }),
		).resolves.toEqual({
			action: "install-packages",
			packages: ["build-essential"],
		});
		expect(mocks.load).toHaveBeenCalledWith("alice", id);
		const request = mocks.run.mock.calls[0][0];
		expect(request).toMatchObject({
			connectionId: id,
			connectionRevision: "revision",
			modelId,
			tools: {},
			maxSteps: 1,
			maxOutputTokens: 512,
		});
		expect(request.messages[0].content).not.toContain("secret missing");
		expect(request.messages[0].content).toContain("[REDACTED]");
		expect(mocks.budget).toHaveBeenCalledOnce();
		expect(mocks.codex).not.toHaveBeenCalled();
	},
);
it("does not select a model or bill API usage implicitly", async () => {
	expect(await resolveEnvironmentModel("alice", undefined)).toBeNull();
	await expect(
		resolveEnvironmentModel("alice", {
			harness: "api",
			modelId: `api/${id}/model`,
		}),
	).rejects.toThrow("Confirm API usage");
	await expect(
		diagnoseEnvironmentFailure({ ...input, model: null }),
	).rejects.toThrow("Select a model");
	expect(mocks.run).not.toHaveBeenCalled();
});
it("rejects missing owner connections and batch models", async () => {
	mocks.load.mockResolvedValue(null);
	await expect(
		resolveEnvironmentModel("alice", {
			harness: "api",
			modelId: `api/${id}/model`,
			allowApi: true,
		}),
	).rejects.toThrow("no longer available");
	mocks.load.mockResolvedValue({
		id,
		provider: "openrouter",
		revision: "revision",
		models: [{ id: "model:batch", toolStreamingVerified: false }],
	});
	await expect(
		resolveEnvironmentModel("alice", {
			harness: "api",
			modelId: `api/${id}/model%3Abatch`,
			allowApi: true,
		}),
	).rejects.toThrow("no longer available");
});
it("preserves the exact subscription model without API fallback", async () => {
	mocks.auth.mockResolvedValue(true);
	const model = await resolveEnvironmentModel("alice", {
		harness: "codex",
		modelId: "chosen",
	});
	await diagnoseEnvironmentFailure({ ...input, model });
	expect(mocks.codex).toHaveBeenCalledWith(
		expect.objectContaining({ modelId: "chosen" }),
	);
	expect(mocks.run).not.toHaveBeenCalled();
});
it("rejects arbitrary model-written shell instead of executing it", async () => {
	mocks.run.mockImplementation(async (request) =>
		request.onEvent({
			type: "text-delta",
			text: '{"action":"shell","command":"anything"}',
		}),
	);
	await expect(
		diagnoseEnvironmentFailure({
			...input,
			model: {
				provider: "api",
				connectionId: id,
				revision: "revision",
				modelId: "chosen",
				allowApi: true,
			},
		}),
	).rejects.toThrow("unsupported repair");
});
