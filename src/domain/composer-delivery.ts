/**
 * How the person's message reaches a turn that is running: "queue" waits for
 * the turn's end (and is merged with other waiting messages into one turn),
 * "steer" is read by the running turn at its next step (no extra turn).
 */
export type ComposerDelivery = "queue" | "steer";

export const DEFAULT_COMPOSER_DELIVERY: ComposerDelivery = "queue";

export const COMPOSER_DELIVERY_STORAGE_KEY = "ytimesy:composer-delivery";

export function parseComposerDelivery(value: unknown): ComposerDelivery {
	return value === "steer" ? "steer" : DEFAULT_COMPOSER_DELIVERY;
}

/**
 * The delivery of one send: the remembered choice, except that Ctrl/Cmd+Enter
 * always steers. Only a running turn has a choice; otherwise the send simply
 * starts a turn.
 */
export function deliveryForSend(input: {
	readonly chosen: ComposerDelivery;
	readonly turnRunning: boolean;
	readonly modifier?: boolean;
}): ComposerDelivery | undefined {
	if (!input.turnRunning) return undefined;
	return input.modifier ? "steer" : input.chosen;
}
