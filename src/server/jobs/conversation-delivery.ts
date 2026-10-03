import {
	claimConversationDeliveries,
	settleConversationDelivery,
} from "../adapters/conversation-delivery";
import {
	publishConversationSnapshot,
	realtimeDeliveryConfiguration,
} from "../adapters/realtime-delivery";

const inFlight = new Set<Promise<void>>();

export async function relayConversationDeliveries() {
	if (!realtimeDeliveryConfiguration()) return;
	const available = 16 - inFlight.size;
	if (available <= 0) return;
	const deliveries = await claimConversationDeliveries(available);
	for (const delivery of deliveries) {
		const work = (async () => {
			let delivered = false;
			try {
				delivered = await publishConversationSnapshot(delivery.snapshot);
			} catch {
				/* A room's failure must not stop other rooms or replay model work. */
			}
			await settleConversationDelivery(delivery, delivered);
		})()
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
