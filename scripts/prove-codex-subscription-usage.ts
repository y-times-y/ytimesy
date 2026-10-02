import { randomBytes } from "node:crypto";
import { jsonSchema, type ModelMessage, tool } from "ai";
import {
	applyApiProgress,
	recordedContextUsage,
} from "../src/domain/api-progress";
import { SessionItemId } from "../src/domain/ids";
import {
	type SessionItem,
	sessionItemsFromUnknown,
} from "../src/domain/session-item";
import { readCodexSubscriptionUsage } from "../src/server/adapters/codex-subscription";
import { database } from "../src/server/adapters/database";
import { runCodexSubscriptionAgent } from "../src/server/services/codex-subscription-agent";

if (process.env.CODEX_SUBSCRIPTION_PROOF !== "1")
	throw new Error("Explicit live proof opt-in required.");
const db = database();
try {
	const owners = (
		await db.query<{ user_id: string }>(
			"select user_id from agent_account where provider='codex' and status='connected' and encrypted_codex_auth is not null",
		)
	).rows;
	if (owners.length !== 1)
		throw new Error("Proof requires one unambiguous owner.");
	const userId = owners[0].user_id;
	const modelId = (
		await db.query<{ listed_model_id: string }>(
			"select listed_model_id from agent_session where user_id=$1 and harness='codex' and listed_model_id is not null order by updated_at desc limit 1",
			[userId],
		)
	).rows[0]?.listed_model_id;
	if (!modelId) throw new Error("No saved model.");
	const nonce = randomBytes(12).toString("hex");
	let executions = 0;
	const tools = {
		read_fixture: tool({
			description: "Read the proof verification code.",
			inputSchema: jsonSchema<Record<string, never>>({
				type: "object",
				properties: {},
				additionalProperties: false,
			}),
			execute: async () => {
				if (++executions > 1) throw new Error("Tool limit exceeded.");
				return { code: nonce };
			},
		}),
	};
	let items: SessionItem[] = [];
	let messages: ModelMessage[] = [];
	for (let turn = 1; turn <= 2; turn++) {
		const prompt =
			turn === 1
				? "Call read_fixture then reply only with the code."
				: "Without tools, repeat the previous code.";
		messages.push({ role: "user", content: prompt });
		items.push({
			kind: "userMessage",
			id: SessionItemId(`proof-${turn}`),
			text: prompt,
		});
		messages = await runCodexSubscriptionAgent({
			userId,
			modelId,
			messages,
			tools,
			instructions:
				"Bounded verification. Follow the user and answer only with the verification code. Never call the tool more than once.",
			maxSteps: 3,
			signal: AbortSignal.timeout(60_000),
			onEvent: async (event) => {
				items = applyApiProgress(items, `proof-${turn}`, event);
			},
			onStep: async () => {},
		});
		if (
			!items.some(
				(item) => item.kind === "agentMessage" && item.text.includes(nonce),
			)
		)
			throw new Error("Tool result verification failed.");
		const restored = sessionItemsFromUnknown(JSON.parse(JSON.stringify(items)));
		const context = recordedContextUsage(restored);
		if (
			!context?.context?.modelContextWindow ||
			!context.context.last.totalTokens
		)
			throw new Error("Context did not survive serialization.");
		console.log(
			JSON.stringify({
				turn,
				modelId,
				verified: true,
				context,
				toolExecutions: executions,
			}),
		);
	}
	console.log(
		JSON.stringify({
			subscription: await readCodexSubscriptionUsage(userId),
			nativeInferenceRunner: false,
		}),
	);
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
