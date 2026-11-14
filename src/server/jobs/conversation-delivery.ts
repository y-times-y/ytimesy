import type { ConversationUpdate } from "#/domain/conversation-delivery";
import {
	claimConversationDeliveries,
	conversationSnapshot,
	settleConversationDelivery,
} from "../adapters/conversation-delivery";
import {
	publishConversationUpdate,
	realtimeDeliveryConfiguration,
} from "../adapters/realtime-delivery";

const inFlight = new Set<Promise<void>>();

/**
 * Publishes one claimed update and settles it. A room that cannot merge the
 * delta (another revision, a restart, an older deploy) is sent the chat's
 * full snapshot at once, so deltas never decide correctness.
 */
async function deliver(delivery: {
	update: ConversationUpdate;
	leaseId: string;
}) {
	let sent = delivery.update;
	let delivered = false;
	try {
		const result = await publishConversationUpdate(sent);
		if (result === "resync") {
			const full = await conversationSnapshot(sent.userId, sent.sessionId);
			if (full) {
				sent = full;
				delivered = (await publishConversationUpdate(full)) === true;
			}
		} else delivered = result;
	} catch {
		/* Durable receipt retains this retry; a room's failure must not stop other rooms or replay model work. */
	}
	await settleConversationDelivery(
		{ update: sent, leaseId: delivery.leaseId },
		delivered,
	);
}

/** Worker invocations await their own delivery batch; no cross-request promises or sockets. */
export async function relayConversationDeliveriesOnce(sessionId?: string) {
	if (!realtimeDeliveryConfiguration()) return;
	const deliveries = await claimConversationDeliveries(
		sessionId ? 1 : 16,
		sessionId,
	);
	await Promise.allSettled(deliveries.map(deliver));
}

export async function relayConversationDeliveries() {
	if (!realtimeDeliveryConfiguration()) return;
	const available = 16 - inFlight.size;
	if (available <= 0) return;
	const deliveries = await claimConversationDeliveries(available);
	for (const delivery of deliveries) {
		const work = deliver(delivery)
			.catch(() => {
				/* The bounded lease permits a later recovery sweep. */
			})
			.finally(() => inFlight.delete(work));
		inFlight.add(work);
	}
}
export async function drainConversationDeliveries() {
	await Promise.allSettled([...inFlight]);
}
