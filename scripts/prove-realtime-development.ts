import { randomUUID } from "node:crypto";
import { conversationSnapshot } from "#/server/adapters/conversation-delivery";
import { coordinateConversationTurn } from "#/server/adapters/conversation-turn-control";
import { closeDatabase, database } from "#/server/adapters/database";
import {
	publishConversationSnapshot,
	realtimeDeliveryConfiguration,
	subscribeConversationSnapshot,
} from "#/server/adapters/realtime-delivery";

const config = realtimeDeliveryConfiguration();
if (
	!config ||
	!new URL(config.url).hostname.startsWith("ytimesy-realtime-development.")
)
	throw new Error("Only the development relay may be tested.");
try {
	const session = (
		await database().query<{ id: string; user_id: string }>(
			"select id,user_id from agent_session where harness in ('api','codex') and turn_status <> 'running' order by updated_at desc limit 1",
		)
	).rows[0];
	if (!session)
		throw new Error(
			"No settled conversation is available for a read-only streaming check.",
		);
	if (process.argv.includes("--worker")) {
		// Advance delivery metadata only; the stored conversation and model history are untouched.
		const revision = (
			await database().query<{ revision: string }>(
				"update conversation_delivery set revision=nextval('conversation_delivery_revision'),retry_at=now() where session_id=$1 returning revision::text",
				[session.id],
			)
		).rows[0]?.revision;
		if (!revision) throw new Error("Missing delivery mailbox.");
		let delivered = false;
		for (let attempt = 0; attempt < 10; attempt++) {
			const row = (
				await database().query<{ delivered: boolean }>(
					"select delivered_revision >= $2::bigint delivered from conversation_delivery where session_id=$1",
					[session.id, revision],
				)
			).rows[0];
			if (row?.delivered) {
				delivered = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		if (!delivered)
			throw new Error(
				"Deployed worker did not settle the new delivery revision.",
			);
	}
	const snapshot = await conversationSnapshot(session.user_id, session.id);
	if (!snapshot) throw new Error("No durable delivery snapshot.");
	const unauthorized = await fetch(`${config.url}/snapshot`, {
		method: "POST",
		body: "{}",
		signal: AbortSignal.timeout(5000),
	});
	if (unauthorized.status !== 401)
		throw new Error("Unsigned ingress was not rejected.");
	await publishConversationSnapshot(snapshot);
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), 10_000);
	try {
		const stream = await subscribeConversationSnapshot(
			snapshot,
			session.id,
			controller.signal,
		);
		const reader = stream?.body?.getReader();
		if (!reader) throw new Error("Remote stream is missing.");
		let frame = "";
		const decoder = new TextDecoder();
		while (!frame.includes("\n\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Stream ended before snapshot.");
			frame += decoder.decode(chunk.value, { stream: true });
		}
		if (!frame.includes(`id: ${snapshot.revision}\n`))
			throw new Error("Wrong remote revision.");
		await reader.cancel();
	} finally {
		clearTimeout(deadline);
		controller.abort();
	}
	// An isolated synthetic room never acquires or cancels the actual user's conversation.
	const turn = {
		userId: session.user_id,
		sessionId: randomUUID(),
		turnId: randomUUID(),
		leaseId: randomUUID(),
	};
	const competitor = { ...turn, turnId: randomUUID(), leaseId: randomUUID() };
	try {
		if (!(await coordinateConversationTurn("acquire", turn)))
			throw new Error("Acquire failed.");
		if (await coordinateConversationTurn("acquire", competitor))
			throw new Error("Duplicate worker was admitted.");
		if (!(await coordinateConversationTurn("cancel", turn)))
			throw new Error("Cancellation failed.");
		if (await coordinateConversationTurn("renew", turn))
			throw new Error("Cancelled worker was renewed.");
		if (!(await coordinateConversationTurn("release", turn)))
			throw new Error("Release failed.");
		if (await coordinateConversationTurn("acquire", turn))
			throw new Error("Retired run was replayed.");
	} finally {
		await coordinateConversationTurn("release", turn).catch(() => {});
	}
	console.info(
		JSON.stringify({
			signedStreaming: true,
			unsignedRejected: true,
			duplicateFenced: true,
			cancellationFenced: true,
			retiredReplayRejected: true,
			inferenceCalls: 0,
			newVms: 0,
			deployedWorkerDelivery: process.argv.includes("--worker"),
		}),
	);
} finally {
	await closeDatabase();
}
