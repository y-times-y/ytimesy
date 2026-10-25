/**
 * Paid smoke for the bridge's bedrock route: one streamed call per model
 * (Sol, then Luna), each offered Bedrock Web Search (when on) and one function
 * tool, and asked to search and then call the tool.
 * Prints only status, tokens and the list-price estimate; never credentials.
 * Run only with the operator's approval:
 *
 *   YTIMESY_HARBOR_ROUTE=bedrock YTIMESY_HARBOR_APPROVED=bedrock \
 *   YTIMESY_HARBOR_TOTAL_USD_CAP=0.05 YTIMESY_HARBOR_TRIAL_USD_CAP=0.05 \
 *   YTIMESY_HARBOR_SPEND_LEDGER=.ytimesy/harbor-v2/bedrock-smoke.jsonl \
 *   YTIMESY_HARBOR_EFFORT=low \
 *   pnpm exec tsx evals/harbor_v2/bedrock-smoke.ts
 */
import { jsonSchema, streamText, tool } from "ai";
import { usageCostUsd } from "../../src/domain/model-pricing";
import { apiTokenUsage } from "../../src/server/adapters/api-token-usage";
import {
	BEDROCK_WEB_SEARCH_USD,
	bedrockModelId,
	bedrockWebSearchTools,
	webSearchQueries,
} from "./bedrock";
import { harborBridgeConfig } from "./config";
import { harborRuntime } from "./runtime";
import { guardedLanguageModel, trialSpendGuard } from "./spend";

const MODELS = process.env.YTIMESY_SMOKE_MODELS?.split(",") ?? [
	"openai.gpt-6.1-sol",
	"openai.gpt-6-luna",
];

const base = harborBridgeConfig(process.env);
if (!base.bedrock) throw new Error("Set YTIMESY_HARBOR_ROUTE=bedrock.");
let spent = 0;
for (const model of MODELS) {
	const modelId = bedrockModelId(model, base.bedrock);
	const config = harborBridgeConfig({
		...process.env,
		YTIMESY_HARBOR_MODEL: modelId,
	});
	const guard = trialSpendGuard({
		capUsd: (config.trialUsdCap ?? 0.05) - spent,
		requestLimit: 1,
		parts: () => [],
	});
	const controller = new AbortController();
	const runtime = await harborRuntime({
		config,
		env: process.env,
		userId: "harbor-smoke",
		cacheScope: "bedrock-smoke",
		wrapModel: (inner) => guardedLanguageModel(inner, guard, controller.signal),
	});
	const started = Date.now();
	let status = "ok";
	let toolCalls = 0;
	let searches = 0;
	let chunks = 0;
	let usage = null as ReturnType<typeof apiTokenUsage> | null;
	try {
		const result = streamText({
			model: runtime.model,
			prompt: config.webSearch
				? "Use web search to find the latest released version of the Python package 'requests' on PyPI, then call the ping tool once with that version as text. Do not answer in prose."
				: "Call the ping tool once with text 'hi'. Do not answer in prose.",
			tools: {
				...(config.webSearch ? bedrockWebSearchTools() : {}),
				ping: tool({
					description: "Echo a short text.",
					inputSchema: jsonSchema<{ text: string }>({
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
						additionalProperties: false,
					}),
				}),
			},
			maxOutputTokens: 2000,
			maxRetries: 0,
			...runtime.requestSettings?.("You are a terse test harness."),
		});
		for await (const part of result.fullStream) {
			chunks++;
			if (part.type === "tool-call" && part.toolName === "ping") toolCalls++;
			if (part.type === "tool-result" && part.toolName === "web_search")
				searches += webSearchQueries(part.output);
			if (part.type === "error")
				status = `error: ${String(part.error).slice(0, 200)}`;
		}
		usage = apiTokenUsage(await result.usage);
	} catch (error) {
		status = `failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
	}
	const searchUsd = searches * BEDROCK_WEB_SEARCH_USD;
	const cost =
		(usage ? (usageCostUsd(usage, config.billing) ?? 0) : 0) + searchUsd;
	spent += cost;
	console.log(
		JSON.stringify({
			model: config.modelId,
			status,
			ms: Date.now() - started,
			streamParts: chunks,
			toolCalls,
			searches,
			searchUsd,
			inputTokens: usage?.inputTokens ?? null,
			cacheReadTokens: usage?.cacheReadTokens ?? null,
			cacheWriteTokens: usage?.cacheWriteTokens ?? null,
			outputTokens: usage?.outputTokens ?? null,
			estimatedUsd: cost,
		}),
	);
}
console.log(JSON.stringify({ totalEstimatedUsd: spent }));
