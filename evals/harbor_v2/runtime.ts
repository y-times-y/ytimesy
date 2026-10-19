import { readFile } from "node:fs/promises";
import type { LanguageModel } from "ai";
import { codexSubscriptionModel } from "../../src/server/adapters/codex-subscription";
import { nativeModelCompactor } from "../../src/server/adapters/model-compaction";
import { apiModelRuntime } from "../../src/server/services/api-agent-runtime";
import type { ModelAgentRuntime } from "../../src/server/services/model-agent-loop";
import { API_ENDPOINTS, type HarborBridgeConfig } from "./config";

const KEY_SHAPES: Record<keyof typeof API_ENDPOINTS, RegExp> = {
	"openai-api": /^sk-/,
	anthropic: /^sk-ant-/,
	gemini: /^AIza/,
};

/** The route's key from its environment variable or key file; never logged. */
export async function routeApiKey(
	config: HarborBridgeConfig,
	env: Record<string, string | undefined>,
) {
	if (config.route === "codex-subscription")
		throw new Error("The subscription route has no API key.");
	const fromEnv = config.keyEnv ? env[config.keyEnv]?.trim() : undefined;
	const key =
		fromEnv ||
		(config.keyFile ? (await readFile(config.keyFile, "utf8")).trim() : "");
	if (!KEY_SHAPES[config.route].test(key))
		throw new Error(
			`Expected a ${config.route} API key in ${config.keyEnv} or ${config.keyFile}.`,
		);
	return key;
}

/**
 * The product's model runtime for the configured route, with every model
 * request (native compaction included) passed through `wrapModel` (the
 * trial's spending guard). API routes use apiModelRuntime, the same builder
 * a stored connection uses; the Codex subscription uses the product's
 * subscription transport, which needs the operator's local sign-in
 * (YTIMESY_EVALUATION_CODEX_AUTH_FILE) and a loopback database the caller
 * prepares.
 */
export async function harborRuntime(input: {
	config: HarborBridgeConfig;
	env: Record<string, string | undefined>;
	userId: string;
	cacheScope: string;
	wrapModel: (model: LanguageModel) => LanguageModel;
	fetch?: typeof globalThis.fetch;
}): Promise<ModelAgentRuntime> {
	const { config } = input;
	if (config.route === "codex-subscription") {
		const runtime = await codexSubscriptionModel(
			input.userId,
			config.modelId,
			config.effort,
			false,
			input.cacheScope,
		);
		runtime.model = input.wrapModel(runtime.model);
		// Rebind native compaction to the guarded transport so its requests count too.
		if (runtime.requestSettings)
			runtime.compact = nativeModelCompactor(
				runtime.model,
				"openai",
				runtime.requestSettings,
			);
		return runtime;
	}
	const endpoint = API_ENDPOINTS[config.route];
	return apiModelRuntime({
		provider: endpoint.provider,
		baseUrl: endpoint.baseUrl,
		apiKey: await routeApiKey(config, input.env),
		modelId: config.modelId,
		userId: input.userId,
		connectionId: `harbor:${config.route}`,
		cacheScopeId: input.cacheScope,
		contextCacheKey: JSON.stringify(["harbor", config.route, config.modelId]),
		reasoning: config.effort,
		fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
		wrapModel: input.wrapModel,
	});
}
