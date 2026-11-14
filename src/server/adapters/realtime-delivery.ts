import { AsyncLocalStorage } from "node:async_hooks";
import {
	type ConversationSnapshot,
	type ConversationUpdate,
	isConversationDelta,
	MAX_DELIVERY_BYTES,
} from "#/domain/conversation-delivery";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { executorFetch, hasExecutorBinding } from "./executor-fetch";
import { realtimeDevelopmentConfiguration } from "./realtime-development-config";

/**
 * True once the room took the update; "resync" when it could not merge a
 * delta (its copy is at another revision, it has none, or it predates
 * deltas): it needs a full snapshot.
 */
export type PublishResult = boolean | "resync";
type Publisher = (update: ConversationUpdate) => Promise<PublishResult>;
const publisher = new AsyncLocalStorage<Publisher>();
export function withConversationPublisher<T>(
	publish: Publisher,
	run: () => Promise<T>,
) {
	return publisher.run(publish, run);
}

export function realtimeDeliveryConfiguration() {
	const development =
		!process.env.YTIMESY_REALTIME_URL && !process.env.YTIMESY_REALTIME_SECRET
			? realtimeDevelopmentConfiguration()
			: null;
	const url = process.env.YTIMESY_REALTIME_URL ?? development?.url;
	const secret = process.env.YTIMESY_REALTIME_SECRET ?? development?.secret;
	if (!url && !secret) return null;
	if (!url || !secret || secret.length < 32)
		throw new Error("Realtime delivery configuration is incomplete.");
	const target = new URL(url);
	if (
		target.protocol !== "https:" &&
		!(
			target.protocol === "http:" &&
			["localhost", "127.0.0.1"].includes(target.hostname)
		)
	)
		throw new Error("Realtime delivery requires HTTPS.");
	return { url: target.origin, secret };
}
export async function publishConversationSnapshot(
	snapshot: ConversationSnapshot,
): Promise<boolean> {
	return (await publishConversationUpdate(snapshot)) === true;
}
/** A delta goes to /delta: a room (or executor) that predates it answers 404, so it is resynced. */
export async function publishConversationUpdate(
	update: ConversationUpdate,
): Promise<PublishResult> {
	const publish = publisher.getStore();
	if (publish) return publish(update);
	const config = realtimeDeliveryConfiguration();
	if (!config) return false;
	const delta = isConversationDelta(update);
	const body = JSON.stringify(update);
	if (Buffer.byteLength(body) > MAX_DELIVERY_BYTES) {
		if (delta) return "resync";
		throw new Error("Conversation snapshot exceeds delivery limit.");
	}
	const url = `${config.url}/${delta ? "delta" : "snapshot"}`;
	const response = await executorFetch(url, {
		method: "POST",
		headers: {
			...(await signDeliveryRequest(config.secret, "POST", url, body)),
			"Content-Type": "application/json",
		},
		body,
		signal: AbortSignal.timeout(5000),
	});
	await response.body?.cancel().catch(() => {});
	if (
		delta &&
		(response.status === 400 ||
			response.status === 404 ||
			response.status === 409)
	)
		return "resync";
	if (!response.ok)
		throw new Error(
			`Realtime delivery rejected snapshot (${response.status}).`,
		);
	return true;
}
/**
 * Deletes one chat's Durable Object state (step receipts, history cache,
 * queue, latest snapshot) and its alarm. Idempotent; a no-op without the edge.
 */
export async function purgeConversationState(
	userId: string,
	sessionId: string,
) {
	const config = realtimeDeliveryConfiguration();
	if (!config) return;
	const url = `${config.url}/purge`;
	const body = JSON.stringify({ userId, sessionId });
	const response = await executorFetch(url, {
		method: "POST",
		headers: {
			...(await signDeliveryRequest(config.secret, "POST", url, body)),
			"Content-Type": "application/json",
		},
		body,
		signal: AbortSignal.timeout(10_000),
	});
	await response.body?.cancel().catch(() => {});
	if (!response.ok)
		throw new Error(`Chat state could not be deleted (${response.status}).`);
}
/**
 * Opens a live viewer's WebSocket on the chat's object (the response to hand
 * the browser), seeding an empty or stale room from `snapshot` (read from
 * Postgres) first. Null when there is no edge to hold it: the socket needs the
 * web Worker's service binding.
 */
export async function openConversationLiveSocket(
	snapshot: ConversationSnapshot,
) {
	const config = realtimeDeliveryConfiguration();
	if (!config || !hasExecutorBinding()) return null;
	const query = new URLSearchParams({
		userId: snapshot.userId,
		sessionId: snapshot.sessionId,
		revision: snapshot.revision,
	});
	const url = `${config.url}/live?${query}`;
	const connect = async () =>
		executorFetch(url, {
			headers: {
				...(await signDeliveryRequest(config.secret, "GET", url)),
				Upgrade: "websocket",
			},
		});
	let response = await connect();
	if (response.status === 404 || response.status === 409) {
		await response.body?.cancel();
		// Recover an absent/stale room from PG; never rerun inference to rebuild it.
		await publishConversationSnapshot(snapshot);
		response = await connect();
	}
	if (response.status !== 101) {
		await response.body?.cancel();
		throw new Error(`Live progress socket unavailable (${response.status}).`);
	}
	return response;
}
export async function subscribeConversationSnapshot(
	snapshot: ConversationSnapshot,
	signal: AbortSignal,
	/** The viewer merges `delta` events (a room that predates them ignores this). */
	deltas = false,
) {
	const config = realtimeDeliveryConfiguration();
	if (!config) return null;
	const query = new URLSearchParams({
		userId: snapshot.userId,
		sessionId: snapshot.sessionId,
		revision: snapshot.revision,
		...(deltas ? { deltas: "1" } : {}),
	});
	const url = `${config.url}/stream?${query}`;
	const subscribe = async () =>
		executorFetch(url, {
			headers: await signDeliveryRequest(config.secret, "GET", url),
			signal,
		});
	// One round trip: the subscription carries the snapshot just read from
	// Postgres, so a room without it (a new chat, a restarted object) is seeded
	// instead of answering a miss. An executor that predates this answers 404
	// and is subscribed the old way below.
	const body = JSON.stringify(snapshot);
	let response =
		Buffer.byteLength(body) <= MAX_DELIVERY_BYTES
			? await executorFetch(url, {
					method: "POST",
					headers: {
						...(await signDeliveryRequest(config.secret, "POST", url, body)),
						"Content-Type": "application/json",
					},
					body,
					signal,
				})
			: await subscribe();
	if (response.ok) return response;
	if (response.status === 404 || response.status === 405) {
		await response.body?.cancel();
		response = await subscribe();
	}
	if (response.status === 404 || response.status === 409) {
		await response.body?.cancel();
		// Recover an absent/stale room from PG; never rerun inference to rebuild a stream.
		await publishConversationSnapshot(snapshot);
		response = await subscribe();
	}
	if (!response.ok)
		throw new Error(`Realtime subscription unavailable (${response.status}).`);
	return response;
}
