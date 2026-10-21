/**
 * Paid smoke for the bridge's bedrock route: exactly one streamed request
 * per model (Sol, then Luna), each offered one tool and asked to call it.
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
import { bedrockModelId } from "./bedrock";
import { harborBridgeConfig } from "./config";
import { harborRuntime } from "./runtime";
import { guardedLanguageModel, trialSpendGuard } from "./spend";

const MODELS = ["openai.gpt-6.1-sol", "openai.gpt-6-luna"];

const base = harborBridgeConfig(process.env);
if (!base.bedrock) throw new Error("Set YTIMESY_HARBOR_ROUTE=bedrock.");
let spent = 0;
for (const model of MODELS) {
	const modelId = bedrockModelId(model, base.bedrock.profile);
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
	let chunks = 0;
	let usage = null as ReturnType<typeof apiTokenUsage> | null;
	try {
		const result = streamText({
			model: runtime.model,
			prompt: "Call the ping tool once with text 'hi'. Do not answer in prose.",
			tools: {
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
			if (part.type === "tool-call") toolCalls++;
			if (part.type === "error")
				status = `error: ${String(part.error).slice(0, 200)}`;
		}
		usage = apiTokenUsage(await result.usage);
	} catch (error) {
		status = `failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
	}
	const cost = usage ? usageCostUsd(usage, config.billing) : 0;
	spent += cost ?? 0;
	console.log(
		JSON.stringify({
			model: config.modelId,
			status,
			ms: Date.now() - started,
			streamParts: chunks,
			toolCalls,
			inputTokens: usage?.inputTokens ?? null,
			cacheReadTokens: usage?.cacheReadTokens ?? null,
			cacheWriteTokens: usage?.cacheWriteTokens ?? null,
			outputTokens: usage?.outputTokens ?? null,
			estimatedUsd: cost,
		}),
	);
}
console.log(JSON.stringify({ totalEstimatedUsd: spent }));
