import { randomBytes } from "node:crypto";
import {
	isStepCount,
	jsonSchema,
	type ModelMessage,
	streamText,
	tool,
} from "ai";
import { z } from "zod";
import { connectedLanguageModel } from "../src/server/adapters/api-model";
import { database } from "../src/server/adapters/database";
import { codexAccessTokenExpiresAt } from "../src/server/auth/codex-managed-auth";
import { unseal } from "../src/server/auth/token-vault";

// Operator-only transport proof. Never changes product routing, provisions VMs,
// refreshes credentials, writes chat history, or falls back to paid API keys.
if (process.env.CODEX_SUBSCRIPTION_PROOF !== "1") {
	throw new Error(
		"Explicitly enable CODEX_SUBSCRIPTION_PROOF=1 for live inference.",
	);
}

const db = database();
try {
	const owners = await db.query<{
		user_id: string;
		encrypted_codex_auth: string;
	}>(
		"select user_id,encrypted_codex_auth from agent_account where provider='codex' and status='connected' and encrypted_codex_auth is not null",
	);
	if (owners.rows.length !== 1)
		throw new Error("Proof requires one unambiguous connected owner.");
	const owner = owners.rows[0];
	const auth = JSON.parse(await unseal(owner.encrypted_codex_auth));
	if (codexAccessTokenExpiresAt(auth) < Date.now() + 180_000) {
		throw new Error(
			"Saved access token expires too soon; reconnect or refresh through the existing auth service first.",
		);
	}
	const selected = await db.query<{ listed_model_id: string }>(
		"select listed_model_id from agent_session where user_id=$1 and harness='codex' and listed_model_id is not null order by updated_at desc limit 1",
		[owner.user_id],
	);
	const modelId = selected.rows[0]?.listed_model_id;
	if (!modelId || modelId.startsWith("api:"))
		throw new Error("No saved native Codex model is available.");
	console.log(
		JSON.stringify({
			model: modelId,
			nativeCodexInferenceProcess: false,
			credentialSource: "encrypted-device-code-account",
		}),
	);
	for (const baseUrl of [
		"https://api.openai.com/v1",
		"https://chatgpt.com/backend-api/codex",
	]) {
		const started = Date.now();
		let requests = 0;
		let toolExecutions = 0;
		let textDeltas = 0;
		let reasoningDeltas = 0;
		let firstEventMs: number | null = null;
		const nonce = randomBytes(12).toString("hex");
		const statuses: number[] = [];
		const errorCodes: string[] = [];
		const safeFetch: typeof fetch = async (url, init) => {
			if (++requests > 4) throw new Error("Proof request limit exceeded.");
			const destination = new URL(String(url));
			if (
				destination.origin !== new URL(baseUrl).origin ||
				destination.pathname !== `${new URL(baseUrl).pathname}/responses`
			) {
				throw new Error("Unexpected inference destination.");
			}
			const headers = new Headers(init?.headers);
			headers.set("ChatGPT-Account-ID", auth.tokens.account_id);
			const response = await fetch(url, {
				...init,
				headers,
				redirect: "error",
			});
			statuses.push(response.status);
			if (!response.ok) {
				const body = await response
					.clone()
					.json()
					.catch(() => null);
				const parsed = z
					.object({ error: z.object({ code: z.string() }) })
					.safeParse(body);
				const code = parsed.success ? parsed.data.error.code : undefined;
				if (typeof code === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(code))
					errorCodes.push(code);
			}
			return response;
		};
		const model = connectedLanguageModel(
			{
				provider: "openai",
				baseUrl,
				apiKey: auth.tokens.access_token,
				modelId,
			},
			safeFetch,
		);
		const tools = {
			read_fixture: tool({
				description:
					"Read the isolated proof fixture. Its verification code is only available through this tool.",
				inputSchema: jsonSchema<Record<string, never>>({
					type: "object",
					properties: {},
					additionalProperties: false,
				}),
				execute: async () => {
					if (++toolExecutions > 1)
						throw new Error("Fixture tool may execute only once.");
					return {
						verificationCode: nonce,
						fixture: "subscription-tool-roundtrip",
					};
				},
			}),
		};
		const instructions =
			"You are a bounded coding harness transport test. Call read_fixture exactly once when asked to read the fixture. Then reply only with its verificationCode. Do not call other tools or produce more than one sentence.";
		const history: ModelMessage[] = [
			{
				role: "user",
				content:
					"Read the fixture with the tool and report its verification code.",
			},
		];
		try {
			for (let turn = 1; turn <= 2; turn++) {
				if (turn === 2)
					history.push({
						role: "user",
						content:
							"Without calling a tool again, repeat the verification code from the previous turn.",
					});
				const result = streamText({
					model,
					messages: history,
					tools,
					stopWhen: isStepCount(3),
					maxRetries: 0,
					streamRetries: 0,
					providerOptions: {
						openai: {
							store: false,
							instructions,
							reasoningEffort: "low",
							reasoningSummary: "auto",
						},
					},
					abortSignal: AbortSignal.timeout(60_000),
					onError: () => {},
				});
				for await (const part of result.fullStream) {
					if (
						firstEventMs === null &&
						["text-delta", "reasoning-delta", "tool-call"].includes(part.type)
					)
						firstEventMs = Date.now() - started;
					if (part.type === "text-delta") textDeltas++;
					if (part.type === "reasoning-delta") reasoningDeltas++;
					if (part.type === "error") throw new Error("Provider stream failed.");
					if (part.type === "abort")
						throw new Error("Provider stream aborted.");
				}
				const text = await result.text;
				if (
					!text.includes(nonce) ||
					toolExecutions !== 1 ||
					(await result.finishReason) !== "stop"
				)
					throw new Error("Tool result or continuation verification failed.");
				history.push(...(await result.response).messages);
				console.log(
					JSON.stringify({
						endpoint: baseUrl,
						turn,
						verified: true,
						finishReason: await result.finishReason,
					}),
				);
			}
			console.log(
				JSON.stringify({
					endpoint: baseUrl,
					passed: true,
					requests,
					statuses,
					toolExecutions,
					textDeltas,
					reasoningDeltas,
					firstEventMs,
					durationMs: Date.now() - started,
				}),
			);
		} catch (error) {
			if (baseUrl === "https://chatgpt.com/backend-api/codex")
				process.exitCode = 1;
			console.log(
				JSON.stringify({
					endpoint: baseUrl,
					passed: false,
					requests,
					statuses,
					errorCodes,
					toolExecutions,
					textDeltas,
					reasoningDeltas,
					firstEventMs,
					durationMs: Date.now() - started,
					errorType: error instanceof Error ? error.name : "UnknownError",
				}),
			);
		}
	}
} catch (error) {
	console.error(
		JSON.stringify({
			setupFailed: true,
			errorType: error instanceof Error ? error.name : "UnknownError",
			message:
				error instanceof Error && error.message.startsWith("Saved access token")
					? error.message
					: "Proof setup unavailable.",
		}),
	);
	process.exitCode = 1;
} finally {
	await db.end();
}
