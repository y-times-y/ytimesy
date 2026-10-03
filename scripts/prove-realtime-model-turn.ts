import {
	type ConversationSnapshot,
	conversationSnapshotSchema,
} from "#/domain/conversation-delivery";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import {
	deleteAgentSessionForOwner,
	insertAgentSession,
} from "#/server/adapters/agent-sessions";
import { conversationSnapshot } from "#/server/adapters/conversation-delivery";
import { closeDatabase, database } from "#/server/adapters/database";
import { subscribeConversationSnapshot } from "#/server/adapters/realtime-delivery";
import { cancelServerTurn } from "#/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "#/server/services/codex-subscription-session";

// Explicit operator-only live test: existing subscription, no repository tools or API fallback.
if (process.env.REALTIME_MODEL_PROOF !== "1")
	throw new Error("Enable REALTIME_MODEL_PROOF=1.");
const db = database();
const created: { userId: string; sessionId: string }[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function state(sessionId: string) {
	return (
		await db.query<{ state: string }>(
			"select state from api_turn where session_id=$1 order by created_at desc limit 1",
			[sessionId],
		)
	).rows[0]?.state;
}
async function settled(sessionId: string) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const value = await state(sessionId);
		if (value && !["queued", "running"].includes(value)) return value;
		await pause(300);
	}
	throw new Error("Turn did not settle before cleanup deadline.");
}
async function stream(
	userId: string,
	sessionId: string,
	onProgress: (progress: ConversationSnapshot["progress"]) => Promise<boolean>,
) {
	const snapshot = await conversationSnapshot(userId, sessionId);
	if (!snapshot) throw new Error("Missing initial snapshot.");
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), 120_000);
	try {
		const response = await subscribeConversationSnapshot(
			snapshot,
			sessionId,
			controller.signal,
		);
		const reader = response?.body?.getReader();
		if (!reader) throw new Error("Missing deployed stream.");
		let buffer = "";
		const decoder = new TextDecoder();
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Stream ended unexpectedly.");
			buffer += decoder.decode(chunk.value, { stream: true });
			while (buffer.includes("\n\n")) {
				const boundary = buffer.indexOf("\n\n");
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = frame
					.split("\n")
					.find((line) => line.startsWith("data: "));
				if (
					data &&
					(await onProgress(
						conversationSnapshotSchema.shape.progress.parse(
							JSON.parse(data.slice(6)),
						),
					))
				) {
					await reader.cancel();
					return;
				}
			}
		}
	} finally {
		clearTimeout(deadline);
		controller.abort();
	}
}
try {
	const owners = (
		await db.query<{ user_id: string }>(
			"select user_id from agent_account where provider='codex' and status='connected' and encrypted_codex_auth is not null",
		)
	).rows;
	if (owners.length !== 1)
		throw new Error("Requires one connected Codex owner.");
	const userId = owners[0].user_id;
	const source = (
		await db.query<{
			project_id: string;
			workspace_id: string;
			listed_model_id: string;
		}>(
			"select project_id,workspace_id,listed_model_id from agent_session where user_id=$1 and harness='codex' and listed_model_id is not null order by updated_at desc limit 1",
			[userId],
		)
	).rows[0];
	if (!source) throw new Error("No current subscription model.");
	console.info(
		JSON.stringify({
			model: source.listed_model_id,
			transport: "deployed-worker-and-durable-object",
			newVms: 0,
		}),
	);
	for (const cancel of [false, true]) {
		const session = await insertAgentSession({
			userId,
			projectId: source.project_id,
			workspaceId: source.workspace_id,
			harness: "codex",
			title: "Isolated realtime proof",
			listedModelId: source.listed_model_id,
		});
		created.push({ userId, sessionId: session.id });
		const started = Date.now();
		await sendSubscriptionTask(
			{ userId, projectId: source.project_id, sessionId: session.id },
			{
				modelId: source.listed_model_id,
				variant: "low",
				text: cancel
					? "This is a bounded streaming cancellation test, not a coding task. Do not use tools or create child tasks. Write 300 numbered short sentences about JavaScript, without a preamble."
					: "This is a bounded streaming delivery test, not a coding task. Do not use tools or create child tasks. Write 60 numbered short sentences about JavaScript. End with REALTIME_PROOF_COMPLETE.",
			},
		);
		let firstTextMs: number | undefined;
		let reasoning = false;
		let text = "";
		let updates = 0;
		let stoppedAt = 0;
		await stream(userId, session.id, async (progress) => {
			const items = sessionItemsFromUnknown(progress.items);
			const next = items
				.filter((i) => i.kind === "agentMessage")
				.map((i) => i.text)
				.join("\n");
			reasoning ||= items.some(
				(i) => i.kind === "reasoning" && i.summaries.some((s) => s.length),
			);
			if (next && next !== text) {
				text = next;
				updates++;
				firstTextMs ??= Date.now() - started;
			}
			if (!next) return false;
			if (cancel) {
				stoppedAt = Date.now();
				await cancelServerTurn(userId, session.id);
				return true;
			}
			return true; // Intentionally disconnect while inference continues.
		});
		if (cancel) {
			if ((await settled(session.id)) !== "cancelled")
				throw new Error("Stop did not win turn finalization.");
			console.info(
				JSON.stringify({
					cancellation: true,
					firstTextMs,
					stopToSettledMs: Date.now() - stoppedAt,
				}),
			);
			await sendSubscriptionTask(
				{ userId, projectId: source.project_id, sessionId: session.id },
				{
					modelId: source.listed_model_id,
					variant: "low",
					text: "Do not use tools or create tasks. Reply only RECOVERY_PROOF_COMPLETE.",
				},
			);
			let recovered = false;
			await stream(userId, session.id, async (progress) => {
				recovered = sessionItemsFromUnknown(progress.items).some(
					(item) =>
						item.kind === "agentMessage" &&
						item.text.includes("RECOVERY_PROOF_COMPLETE"),
				);
				if (progress.turnStatus === "failed")
					throw new Error("Post-stop recovery failed.");
				return progress.turnStatus === "completed";
			});
			if (!recovered || (await settled(session.id)) !== "completed")
				throw new Error("Post-stop recovery was not verified.");
			console.info(JSON.stringify({ explicitFollowupAfterStop: true }));
		} else {
			await stream(userId, session.id, async (progress) => {
				const items = sessionItemsFromUnknown(progress.items);
				const next = items
					.filter((i) => i.kind === "agentMessage")
					.map((i) => i.text)
					.join("\n");
				reasoning ||= items.some(
					(i) => i.kind === "reasoning" && i.summaries.some((s) => s.length),
				);
				if (next !== text) {
					text = next;
					updates++;
				}
				if (progress.turnStatus === "failed")
					throw new Error("Live model turn failed.");
				return progress.turnStatus === "completed";
			});
			if (
				(await settled(session.id)) !== "completed" ||
				!text.includes("REALTIME_PROOF_COMPLETE") ||
				updates < 2
			)
				throw new Error("Streaming or completion proof failed.");
			console.info(
				JSON.stringify({
					completion: true,
					reconnect: true,
					textUpdates: updates,
					reasoningVisible: reasoning,
					firstTextMs,
					totalMs: Date.now() - started,
				}),
			);
		}
		const isolation = (
			await db.query<{ provider_ref: string | null; children: number }>(
				"select provider_ref,(select count(*)::int from agent_session c where c.parent_session_id=s.id) children from agent_session s where id=$1",
				[session.id],
			)
		).rows[0];
		if (isolation.provider_ref || isolation.children)
			throw new Error("Proof unexpectedly provisioned execution.");
	}
} finally {
	for (const session of created) {
		const value = await state(session.sessionId);
		if (value && ["queued", "running"].includes(value)) {
			await cancelServerTurn(session.userId, session.sessionId);
			await settled(session.sessionId);
		}
		await deleteAgentSessionForOwner(session.userId, session.sessionId);
	}
	await closeDatabase();
}
