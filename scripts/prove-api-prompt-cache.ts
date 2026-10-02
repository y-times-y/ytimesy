import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { connectedLanguageModel } from "../src/server/adapters/api-model";
import { apiPromptCacheSettings } from "../src/server/adapters/api-prompt-cache";
import { apiTokenUsage } from "../src/server/adapters/api-token-usage";
import { database } from "../src/server/adapters/database";
import { loadModelConnection } from "../src/server/adapters/model-connections";
import { modelEndpointTransport } from "../src/server/adapters/model-endpoint";
import { connectionApiKey } from "../src/server/services/model-connections";

// Explicit operator proof only. No VM, task, user transcript or repository content is used.
const cap = Number(process.env.CACHE_PROOF_SPEND_CAP ?? 0);
if (!(cap > 0 && cap <= 0.1))
	throw new Error(
		"Set CACHE_PROOF_SPEND_CAP to an authorized maximum no greater than $0.10.",
	);
const db = database();
try {
	const connections = await db.query<{ id: string; user_id: string }>(
		"select id,user_id from model_connection where provider='openrouter' order by created_at",
	);
	if (connections.rows.length !== 1)
		throw new Error(
			"Proof requires one unambiguous saved OpenRouter connection.",
		);
	const owner = connections.rows[0];
	const connection = await loadModelConnection(owner.user_id, owner.id);
	if (!connection) throw new Error("Owned connection unavailable.");
	const transport = modelEndpointTransport(connection.baseUrl);
	try {
		const catalog = await transport.fetch(`${connection.baseUrl}/models`);
		if (!catalog.ok) throw new Error(`Catalog failed: ${catalog.status}`);
		const { data } = (await catalog.json()) as {
			data: {
				id: string;
				created: number;
				pricing: { prompt: string; completion: string };
			}[];
		};
		const fixture =
			`Private cache proof ${randomUUID()}\n` +
			Array.from(
				{ length: 300 },
				(_, i) =>
					`Record ${i}: const cacheFixture${i} = { version: ${i}, valid: true };\n`,
			).join("");
		let reserved = 0;
		for (const prefix of ["anthropic/claude-haiku-", "google/gemini-"]) {
			const candidates = data
				.filter(
					(model) =>
						model.id.startsWith(prefix) &&
						!model.id.includes(":") &&
						(prefix.startsWith("anthropic") || model.id.includes("flash")),
				)
				.sort((a, b) => b.created - a.created);
			const selected = candidates.find((row) => {
				const inputPrice = Number(row.pricing.prompt);
				const outputPrice = Number(row.pricing.completion);
				return (
					Number.isFinite(inputPrice) &&
					inputPrice > 0 &&
					Number.isFinite(outputPrice) &&
					outputPrice >= 0 &&
					reserved +
						2 *
							((Buffer.byteLength(fixture) + 4096) * inputPrice * 2 +
								64 * outputPrice) <=
						cap
				);
			});
			if (!selected) {
				console.log(
					JSON.stringify({
						provider: prefix,
						skipped: "Conservative spend bound exceeds remaining cap",
					}),
				);
				continue;
			}
			// UTF-8 bytes bound fixture tokens; reserve twice normal input price for cache writes.
			reserved +=
				2 *
				((Buffer.byteLength(fixture) + 4096) *
					Number(selected.pricing.prompt) *
					2 +
					64 * Number(selected.pricing.completion));
			const model = connectedLanguageModel(
				{
					...connection,
					apiKey: await connectionApiKey(owner.user_id, connection),
					modelId: selected.id,
				},
				transport.fetch,
			);
			const cacheSettings = apiPromptCacheSettings({
				...connection,
				userId: owner.user_id,
				connectionId: connection.id,
				scopeId: randomUUID(),
			});
			for (let request = 1; request <= 2; request++) {
				const response = await generateText({
					model,
					...cacheSettings,
					prompt: fixture,
					maxOutputTokens: 64,
					maxRetries: 0,
					abortSignal: AbortSignal.timeout(60_000),
				});
				console.log(
					JSON.stringify({
						model: selected.id,
						request,
						usage: apiTokenUsage(response.usage),
					}),
				);
			}
		}
		console.log(
			JSON.stringify({
				conservativeReservedUsd: reserved,
				authorizedCapUsd: cap,
			}),
		);
	} finally {
		await transport.close();
	}
} catch (error) {
	console.error(
		JSON.stringify({
			failed: true,
			errorType: error instanceof Error ? error.name : "UnknownError",
		}),
	);
	process.exitCode = 1;
} finally {
	await db.end();
}
