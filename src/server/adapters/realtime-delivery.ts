import { AsyncLocalStorage } from "node:async_hooks";
import type { ConversationSnapshot } from "#/domain/conversation-delivery";
import { MAX_DELIVERY_BYTES } from "#/domain/conversation-delivery";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { realtimeDevelopmentConfiguration } from "./realtime-development-config";

const publisher = new AsyncLocalStorage<
	(snapshot: ConversationSnapshot) => Promise<boolean>
>();
export function withConversationPublisher<T>(
	publish: (snapshot: ConversationSnapshot) => Promise<boolean>,
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
) {
	const publish = publisher.getStore();
	if (publish) return publish(snapshot);
	const config = realtimeDeliveryConfiguration();
	if (!config) return false;
	const body = JSON.stringify(snapshot);
	if (Buffer.byteLength(body) > MAX_DELIVERY_BYTES)
		throw new Error("Conversation snapshot exceeds delivery limit.");
	const url = `${config.url}/snapshot`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			...(await signDeliveryRequest(config.secret, "POST", url, body)),
			"Content-Type": "application/json",
		},
		body,
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok)
		throw new Error(
			`Realtime delivery rejected snapshot (${response.status}).`,
		);
	return true;
}
export async function subscribeConversationSnapshot(
	snapshot: ConversationSnapshot,
	displaySessionId: string,
	signal: AbortSignal,
) {
	const config = realtimeDeliveryConfiguration();
	if (!config) return null;
	const query = new URLSearchParams({
		userId: snapshot.userId,
		sessionId: snapshot.sessionId,
		displaySessionId,
		revision: snapshot.revision,
	});
	const url = `${config.url}/stream?${query}`;
	const subscribe = async () =>
		fetch(url, {
			headers: await signDeliveryRequest(config.secret, "GET", url),
			signal,
		});
	let response = await subscribe();
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
