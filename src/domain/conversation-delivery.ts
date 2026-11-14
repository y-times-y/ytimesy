import { z } from "zod";

const revisionSchema = z.string().regex(/^[1-9]\d{0,19}$/);
/** agent_session.items_rev; 0 for a chat whose items were never rewritten. */
const itemsRevSchema = z.string().regex(/^(0|[1-9]\d{0,19})$/);
const turnStatusSchema = z.enum(["idle", "running", "completed", "failed"]);

/**
 * Where a snapshot's items sit in the chat's stored transcript
 * (agent_session_item positions): stored positions [first, end) at revision
 * itemsRev, in order, except the `hidden` ones the view drops; then the
 * queued messages. It lets a receiver merge a delta into its copy.
 */
export const transcriptWindowSchema = z.object({
	itemsRev: itemsRevSchema,
	first: z.number().int().min(0),
	end: z.number().int().min(0),
	hidden: z.array(z.number().int().min(0)),
});
export type TranscriptWindow = z.infer<typeof transcriptWindowSchema>;

/** Reconnects replace the latest snapshot; they never replay model inference. */
export const conversationSnapshotSchema = z.object({
	userId: z.string().min(1).max(256),
	sessionId: z.uuid(),
	revision: revisionSchema,
	progress: z.object({
		sessionId: z.uuid(),
		items: z.array(z.unknown()),
		/** The items are the chat's last turns; it holds turns before them. */
		hasOlderItems: z.boolean().optional(),
		turnStatus: turnStatusSchema,
		usage: z.unknown().optional(),
	}),
	/** Absent from snapshots of servers that predate deltas: such a copy only takes full snapshots. */
	window: transcriptWindowSchema.optional(),
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export const MAX_DELIVERY_BYTES = 4 * 1024 * 1024;

/**
 * What changed since the receiver's copy at items revision `baseItemsRev`:
 * the stored rows written after it inside the new window (each already as the
 * view shows it, null when the view drops it), the new window's bounds (rows
 * past `end` were removed), and the small whole-chat state (queued messages,
 * turn status, usage). Merged by applyConversationDelta; a copy at another
 * revision cannot take it and reads a full snapshot instead.
 */
export const conversationDeltaBodySchema = z.object({
	baseItemsRev: itemsRevSchema,
	window: z.object({
		itemsRev: itemsRevSchema,
		first: z.number().int().min(0),
		end: z.number().int().min(0),
	}),
	rows: z.array(
		z.object({
			position: z.number().int().min(0),
			item: z.unknown().nullable(),
		}),
	),
	/** The chat's waiting messages, as the view shows them (queued: true). */
	queued: z.array(z.unknown()),
	hasOlderItems: z.boolean(),
	turnStatus: turnStatusSchema,
	usage: z.unknown().optional(),
});
export type ConversationDeltaBody = z.infer<typeof conversationDeltaBodySchema>;
export const conversationDeltaSchema = conversationDeltaBodySchema.extend({
	kind: z.literal("delta"),
	userId: z.string().min(1).max(256),
	sessionId: z.uuid(),
	revision: revisionSchema,
});
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
/** What a delivery carries: a full snapshot, or a delta against the receiver's copy. */
export type ConversationUpdate = ConversationSnapshot | ConversationDelta;
export function isConversationDelta(
	update: ConversationUpdate,
): update is ConversationDelta {
	return "kind" in update && update.kind === "delta";
}

type LiveCopy = {
	progress: { sessionId: string; items: readonly unknown[] };
	window?: TranscriptWindow;
};
const itemId = (item: unknown) =>
	item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;

/**
 * The copy after `delta`, or null when the copy cannot take it (it is at
 * another items revision, or lacks rows the delta assumes it holds): the
 * receiver then reads a full snapshot. Never guesses a missing row.
 */
export function applyConversationDelta(
	copy: LiveCopy,
	delta: ConversationDeltaBody,
): {
	progress: ConversationSnapshot["progress"];
	window: TranscriptWindow;
} | null {
	const window = copy.window;
	if (!window || window.itemsRev !== delta.baseItemsRev) return null;
	if (window.end < window.first || delta.window.end < delta.window.first)
		return null;
	// The copy's rows by position (null: held but not shown).
	const hidden = new Set(window.hidden);
	const rows = new Map<number, unknown>();
	let next = 0;
	for (let position = window.first; position < window.end; position++) {
		if (hidden.has(position)) rows.set(position, null);
		else if (next < copy.progress.items.length)
			rows.set(position, copy.progress.items[next++]);
		else return null;
	}
	for (const row of delta.rows) rows.set(row.position, row.item ?? null);
	const items: unknown[] = [];
	const nextHidden: number[] = [];
	for (
		let position = delta.window.first;
		position < delta.window.end;
		position++
	) {
		// A row the copy never held and the delta does not carry (the window
		// grew backwards past the copy): only a full snapshot has it.
		if (!rows.has(position)) return null;
		const item = rows.get(position);
		if (item === null || item === undefined) nextHidden.push(position);
		else items.push(item);
	}
	const shown = new Set(items.map(itemId));
	return {
		progress: {
			sessionId: copy.progress.sessionId,
			items: [
				...items,
				...delta.queued.filter((item) => !shown.has(itemId(item))),
			],
			hasOlderItems: delta.hasOlderItems,
			turnStatus: delta.turnStatus,
			...(delta.usage === undefined ? {} : { usage: delta.usage }),
		},
		window: { ...delta.window, hidden: nextHidden },
	};
}

/** A full snapshot: every viewer can take it (old ones ignore `window`). */
export function conversationEvent(snapshot: ConversationSnapshot) {
	return `retry: 250\nid: ${snapshot.revision}\nevent: progress\ndata: ${JSON.stringify({ ...snapshot.progress, sessionId: snapshot.sessionId, ...(snapshot.window ? { window: snapshot.window } : {}) })}\n\n`;
}

/** A delta, only to viewers that asked for them (a `delta` event older pages never listen to). */
export function conversationDeltaEvent(delta: ConversationDelta) {
	const { kind: _kind, userId: _userId, revision, ...body } = delta;
	return `id: ${revision}\nevent: delta\ndata: ${JSON.stringify(body)}\n\n`;
}
