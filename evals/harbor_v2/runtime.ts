import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LanguageModel } from "ai";
import { pricedModelId } from "../../src/domain/model-pricing";
import { codexSubscriptionModel } from "../../src/server/adapters/codex-subscription";
import { nativeModelCompactor } from "../../src/server/adapters/model-compaction";
import { apiModelRuntime } from "../../src/server/services/api-agent-runtime";
import type { ModelAgentRuntime } from "../../src/server/services/model-agent-loop";
import {
	bedrockAnthropicProfile,
	bedrockCredentials,
	bedrockSigningFetch,
	responseTimeLimitFetch,
} from "./bedrock";
import {
	anthropicClientModel,
	BEDROCK_ANTHROPIC_BASE_URL,
	bedrockAnthropicFetch,
} from "./bedrock-anthropic";
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
	if (config.route === "codex-subscription" || config.route === "bedrock")
		throw new Error(`The ${config.route} route has no API key.`);
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
	if (config.route === "bedrock")
		return bedrockAnthropicProfile(config.modelId)
			? bedrockClaudeRuntime(input)
			: bedrockRuntime(input);
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

/**
 * Claude models in Amazon Bedrock (bedrock-anthropic.ts): the product's
 * Anthropic Messages runtime, its requests sent to bedrock-runtime as the
 * model's inference profile and signed from the operator's AWS credentials.
 * The client gets the Anthropic API's own id (claude-haiku-5-5) for pricing
 * and request settings; no catalog lookup or native compaction (neither is
 * on Bedrock's Messages route), so the context window is the stated one.
 */
async function bedrockClaudeRuntime(input: {
	config: HarborBridgeConfig;
	env: Record<string, string | undefined>;
	userId: string;
	cacheScope: string;
	wrapModel: (model: LanguageModel) => LanguageModel;
	fetch?: typeof globalThis.fetch;
}): Promise<ModelAgentRuntime> {
	const { config } = input;
	const bedrock = config.bedrock;
	if (!bedrock) throw new Error("The bedrock route needs its settings.");
	const profile = bedrockAnthropicProfile(config.modelId);
	if (!profile)
		throw new Error(`"${config.modelId}" is not a Bedrock Claude id.`);
	const clientModel = anthropicClientModel(profile);
	const runtime = await apiModelRuntime({
		provider: "anthropic",
		baseUrl: BEDROCK_ANTHROPIC_BASE_URL,
		// The Anthropic client needs a key; Bedrock is signed instead.
		apiKey: "aws-sigv4",
		modelId: clientModel,
		userId: input.userId,
		connectionId: `harbor:${config.route}`,
		cacheScopeId: input.cacheScope,
		contextCacheKey: JSON.stringify(["harbor", config.route, config.modelId]),
		contextWindow: BEDROCK_CLAUDE_CONTEXT_WINDOW,
		reasoning: config.effort,
		fetch: bedrockAnthropicFetch({
			credentials: await bedrockCredentials(input.env),
			region: bedrock.region,
			profile,
			fetch: responseTimeLimitFetch(
				input.fetch ?? globalThis.fetch.bind(globalThis),
			),
		}),
		wrapModel: input.wrapModel,
	});
	return { ...runtime, maxOutputTokens: BEDROCK_MAX_OUTPUT_TOKENS };
}

/** Bedrock serves Claude with a 200K-token context window. */
export const BEDROCK_CLAUDE_CONTEXT_WINDOW = 200_000;

/** The bedrock route's output cap per response. */
export const BEDROCK_MAX_OUTPUT_TOKENS = 64_000;

/**
 * OpenAI models in Amazon Bedrock (bedrock.ts): the product's OpenAI
 * Responses runtime pointed at bedrock-mantle (or bedrock-runtime), every request SigV4-signed
 * from the operator's AWS credentials. The OpenAI client is given the bare
 * model id (gpt-6-luna) so it treats the model exactly as on the openai-api
 * route (reasoning effort, developer instructions, catalog context window);
 * the signer sends the Bedrock id (openai.gpt-6-luna on mantle,
 * global.openai.gpt-6-luna on bedrock-runtime) in
 * its place. Prompt caching keys requests to the trial's cache scope as the
 * openai-api route does.
 */
async function bedrockRuntime(input: {
	config: HarborBridgeConfig;
	env: Record<string, string | undefined>;
	userId: string;
	cacheScope: string;
	wrapModel: (model: LanguageModel) => LanguageModel;
	fetch?: typeof globalThis.fetch;
}): Promise<ModelAgentRuntime> {
	const { config } = input;
	const bedrock = config.bedrock;
	if (!bedrock) throw new Error("The bedrock route needs its settings.");
	const credentials = await bedrockCredentials(input.env);
	const clientModel = pricedModelId(config.modelId);
	const runtime = await apiModelRuntime({
		provider: "openai",
		baseUrl: bedrock.baseUrl,
		// The OpenAI client needs a key; the signer replaces its header.
		apiKey: "aws-sigv4",
		modelId: clientModel,
		userId: input.userId,
		connectionId: `harbor:${config.route}`,
		cacheScopeId: input.cacheScope,
		contextCacheKey: JSON.stringify(["harbor", config.route, config.modelId]),
		reasoning: config.effort,
		fetch: bedrockSigningFetch({
			credentials,
			region: bedrock.region,
			endpoint: bedrock.endpoint,
			// One request's wall time is bounded (responseTimeLimitFetch).
			fetch: responseTimeLimitFetch(
				input.fetch ?? globalThis.fetch.bind(globalThis),
			),
			model: { client: clientModel, profile: config.modelId },
		}),
		wrapModel: input.wrapModel,
	});
	const promptCacheKey = createHash("sha256")
		.update(`ytimesy:harbor:${input.userId}:${input.cacheScope}`)
		.digest("hex");
	const requestSettings = runtime.requestSettings;
	return {
		...runtime,
		// A large but finite output cap. The API default (8K) cut Luna at max
		// effort mid tool call (a sidekick lost three steps in a row to
		// response.incomplete); with no cap one response ran away for 30
		// minutes (1.6 MB). A step cut at this cap is resampled once with a
		// note to work in smaller steps (model-agent-loop's outputLimitCut).
		maxOutputTokens: BEDROCK_MAX_OUTPUT_TOKENS,
		requestSettings: requestSettings
			? (instructions) => {
					const settings = requestSettings(instructions);
					return {
						...settings,
						providerOptions: {
							...settings.providerOptions,
							openai: {
								...settings.providerOptions?.openai,
								promptCacheKey,
							},
						},
					};
				}
			: undefined,
	};
}
