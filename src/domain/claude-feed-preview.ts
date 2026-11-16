import type { ApiAgentEvent } from "./api-agent-event";
import { applyApiProgress } from "./api-progress";
import { claudeCodeEffects } from "./claude-code-stream";
import { redactSecretValues } from "./project-secret";
import type { SessionItem } from "./session-item";

/**
 * A preview of a Claude Code run's text while its turn's step sleeps.
 *
 * Lines the runner pushes (claude-feed.ts) wait in the chat's object until
 * a step reads them, publishes them and so moves the chat's revision. While
 * someone watches, the object maps a batch's text and reasoning itself,
 * redacted like the step's, and sends it to the open chat's sockets as a
 * frame without a revision: an older page ignores it (it reads only frames
 * with one), a current page shows it in the running turn until the step
 * publishes the same item. Tool calls and the run's result are not
 * previewed: they wake the step at once.
 */
export const LIVE_PREVIEW_TYPE = "preview";

export type LivePreviewEvent = Extract<
	ApiAgentEvent,
	{ type: "text-delta" | "reasoning-delta" | "reasoning-end" }
>;

export type LivePreviewMessage = {
	readonly type: typeof LIVE_PREVIEW_TYPE;
	readonly turnId: string;
	readonly events: readonly LivePreviewEvent[];
};

/** Largest preview frame sent; a larger batch is left to the step. */
export const LIVE_PREVIEW_MAX_CHARS = 256 * 1024;

/**
 * The preview of stored lines (entries are [byte offset, line], keyed as
 * the step keys them, so the items get the step's ids); nothing to show is
 * an empty event list.
 */
export function claudeFeedPreview(
	turnId: string,
	entries: readonly (readonly [number, string])[],
	secrets: readonly string[],
): LivePreviewMessage {
	const events: LivePreviewEvent[] = [];
	for (const [offset, line] of entries)
		for (const effect of claudeCodeEffects(line, String(offset), {
			toolName: () => undefined,
		}))
			if (effect.kind === "event" && isPreviewEvent(effect.event))
				events.push(
					secrets.length
						? redactSecretValues(effect.event, secrets)
						: effect.event,
				);
	return { type: LIVE_PREVIEW_TYPE, turnId, events };
}

/** The socket frame for a preview, or null when it would be too large. */
export function livePreviewFrame(message: LivePreviewMessage) {
	const frame = JSON.stringify(message);
	return frame.length > LIVE_PREVIEW_MAX_CHARS ? null : frame;
}

function isPreviewEvent(event: ApiAgentEvent): event is LivePreviewEvent {
	return (
		event.type === "text-delta" ||
		event.type === "reasoning-delta" ||
		event.type === "reasoning-end"
	);
}

/** A preview frame from the chat's socket, or null for anything else. */
export function parseLivePreview(value: unknown): LivePreviewMessage | null {
	if (!value || typeof value !== "object") return null;
	const { type, turnId, events } = value as Record<string, unknown>;
	if (
		type !== LIVE_PREVIEW_TYPE ||
		typeof turnId !== "string" ||
		!turnId ||
		!Array.isArray(events)
	)
		return null;
	const valid = events.filter((event): event is LivePreviewEvent => {
		if (!event || typeof event !== "object") return false;
		const {
			type: kind,
			id,
			text,
			durationSeconds,
		} = event as Record<string, unknown>;
		if (typeof id !== "string" || !id) return false;
		if (kind === "text-delta" || kind === "reasoning-delta")
			return typeof text === "string";
		return kind === "reasoning-end" && typeof durationSeconds === "number";
	});
	return { type: LIVE_PREVIEW_TYPE, turnId, events: valid };
}

/** Previewed events the page keeps until the step publishes their items. */
export type LivePreviews = readonly {
	readonly turnId: string;
	readonly event: LivePreviewEvent;
}[];

/**
 * The kept previews with a frame's events added; an event the page already
 * keeps (a frame sent again) is not added twice.
 */
export function addLivePreviews(
	previews: LivePreviews,
	message: LivePreviewMessage,
): LivePreviews {
	const added = message.events
		.filter(
			(event) =>
				!previews.some(
					(kept) =>
						kept.turnId === message.turnId &&
						kept.event.type === event.type &&
						kept.event.id === event.id,
				),
		)
		.map((event) => ({ turnId: message.turnId, event }));
	return added.length ? [...previews, ...added] : previews;
}

function previewItemId(turnId: string, event: LivePreviewEvent) {
	return `${turnId}:${event.id}`;
}

/** Previews whose items the published copy does not have yet. */
export function pendingLivePreviews(
	items: readonly SessionItem[],
	previews: LivePreviews,
): LivePreviews {
	if (!previews.length) return previews;
	const published = new Set(items.map((item) => item.id as string));
	return previews.filter(
		({ turnId, event }) => !published.has(previewItemId(turnId, event)),
	);
}

/**
 * The published items with the pending previews after them, as the step
 * will add them; an item the step published is never shown twice.
 */
export function withLivePreviews(
	items: readonly SessionItem[],
	previews: LivePreviews,
): SessionItem[] {
	let shown = [...items];
	for (const { turnId, event } of pendingLivePreviews(items, previews))
		shown = applyApiProgress(shown, turnId, event);
	return shown;
}
