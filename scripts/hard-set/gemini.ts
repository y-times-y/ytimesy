// The development Gemini key for hard-set and instruction-tuning runs. The key
// is read from a file, sent only in the x-goog-api-key header (as the product's
// Google route does) and never printed.
import { readFile } from "node:fs/promises";
import type { ConnectedModel } from "../../src/domain/model-connection";
import { MODEL_PROVIDERS } from "../../src/domain/model-connection";
import { discoverConnectionModels } from "../../src/server/adapters/model-catalog";
import { modelEndpointTransport } from "../../src/server/adapters/model-endpoint";
import { type GeminiQuota, geminiQuotaFromResponse } from "./route";

export const DEFAULT_GEMINI_KEY_FILE = ".secrets/gemini-api-key";
const BASE_URL = MODEL_PROVIDERS.google.baseUrl as string;

export async function readGeminiKey(path = DEFAULT_GEMINI_KEY_FILE) {
	const key = (await readFile(path, "utf8")).trim();
	if (key.length < 20) throw new Error(`No Gemini key in ${path}.`);
	return key;
}

/** The key's model catalog entry for `modelId` (a models list call: no generation quota). */
export async function geminiConnectionModels(
	apiKey: string,
	modelId: string,
): Promise<ConnectedModel[]> {
	const transport = modelEndpointTransport(BASE_URL);
	try {
		const models = await discoverConnectionModels(
			{ provider: "google", baseUrl: BASE_URL, apiKey },
			transport.fetch,
		);
		const model = models.find((entry) => entry.id === modelId);
		if (!model) throw new Error(`The Gemini key does not list ${modelId}.`);
		return [model];
	} finally {
		await transport.close();
	}
}

/**
 * One tiny generateContent request (counts as one request against the
 * free tier's per-minute and per-day quotas) to read the quota state.
 */
export async function probeGeminiQuota(
	apiKey: string,
	modelId: string,
): Promise<GeminiQuota> {
	const response = await fetch(
		`${BASE_URL}/models/${encodeURIComponent(modelId)}:generateContent`,
		{
			method: "POST",
			headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: "Reply with ok." }] }],
				generationConfig: { maxOutputTokens: 16 },
			}),
			signal: AbortSignal.timeout(30_000),
		},
	);
	return geminiQuotaFromResponse(
		response.status,
		(await response.text()).replaceAll(apiKey, "[key]"),
	);
}
