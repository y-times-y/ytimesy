import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { recordedContextUsage } from "./api-progress";
import type {
	SessionItem,
	SessionTurnStatus,
	UserMessageItem,
} from "./session-item";
import { withQueuedUserMessages } from "./session-item";

/**
 * Delta reads of the open chat. The browser holds a server view and the
 * transcript token it was read at (the chat's write revision and item count).
 * Asking "anything new since that token?" costs a few hundred bytes when
 * nothing changed; otherwise the server sends the transcript from the first
 * changed item on, and the browser puts it after the item it already has
 * just before that point (the anchor).
 */
export type SessionReadToken = {
	readonly rev: number;
	readonly count: number;
};

/** The chat's fields that live on its row, so a delta carries them exactly. */
export type SessionRowFields = {
	readonly turnStatus: SessionTurnStatus;
	readonly workspaceId: string | null;
	readonly selectedBranch: string | null;
	readonly listedModelId: string;
};

export type SessionDeltaChange = {
	/** The item just before the changed tail that the view shows; null when the tail starts the chat. */
	readonly anchorId: string | null;
	/** The chat's items from the first change on, as the view shows them. */
	readonly tail: readonly SessionItem[];
};

export type SessionReadDelta = {
	readonly mode: "delta";
	readonly token: SessionReadToken;
	readonly row: SessionRowFields;
	/** Null when no item changed. */
	readonly change: SessionDeltaChange | null;
	/** The messages still waiting for delivery. */
	readonly queued: readonly UserMessageItem[];
	/**
	 * Present when the browser asked for them: the view's fields that are not
	 * on the chat row or in its transcript, read as a whole read reads them.
	 */
	readonly fields?: SessionViewFields;
};

/** The view's fields a delta can refresh without the transcript. A key left out means the view has none. */
export const SESSION_VIEW_FIELD_KEYS = [
	"snapshotAvailable",
	"connection",
	"models",
	"blockedListedModelIds",
	"canSend",
	"sendBlockers",
] as const;

export type SessionViewFields = Partial<
	Pick<PublicCodexSession, (typeof SESSION_VIEW_FIELD_KEYS)[number]>
>;

/** The view with its refreshable fields replaced by `fields` (a key absent from them is removed). */
export function withViewFields<View extends object>(
	view: View,
	fields: SessionViewFields,
): View {
	const next = { ...view } as Record<string, unknown>;
	for (const key of SESSION_VIEW_FIELD_KEYS) {
		if (key in fields) next[key] = fields[key];
		else delete next[key];
	}
	return next as unknown as View;
}

export type SessionReadFull<View> = {
	readonly mode: "full";
	readonly view: View;
	/** Null when the chat has no token (no chat, or the server cannot make one). */
	readonly token: SessionReadToken | null;
	/** How many items at the end of the view are waiting messages. */
	readonly queuedCount: number;
};

type DeltaView = {
	readonly items: readonly SessionItem[];
	readonly turnStatus: SessionTurnStatus;
	readonly workspaceId: string | null;
	readonly selectedBranch?: string | null;
	readonly listedModelId: string;
	readonly hasOlderItems?: boolean;
};

/** A server view the browser holds, with what a delta needs to build on it. */
export type HeldSessionRead<View> = {
	readonly view: View;
	readonly token: SessionReadToken;
	readonly queuedCount: number;
	/** When the view was last read whole (the fields a delta does not carry). */
	readonly fullAt: number;
};

/**
 * The view a delta leads to, or null when the browser cannot build it from
 * what it holds (the changed tail is not anchored in its items, the ids
 * collide): the caller then reads the chat whole.
 */
export function applySessionDelta<View extends DeltaView>(
	held: HeldSessionRead<View>,
	delta: SessionReadDelta,
	/** The route keeps the context usage (Codex) in the view's `usage`. */
	keepsUsage: boolean,
): { view: View; queuedCount: number } | null {
	const heldView = delta.fields
		? withViewFields(held.view, delta.fields)
		: held.view;
	const base = heldView.items.slice(
		0,
		heldView.items.length - held.queuedCount,
	);
	let items: readonly SessionItem[] = base;
	if (delta.change) {
		const { anchorId, tail } = delta.change;
		if (anchorId === null) {
			if (held.view.hasOlderItems) return null;
			items = tail;
		} else {
			const at = lastIndexOfId(base, anchorId);
			if (at < 0) return null;
			items = [...base.slice(0, at + 1), ...tail];
		}
		if (new Set(items.map((item) => item.id)).size !== items.length)
			return null;
	}
	const shown = withQueuedUserMessages(items, delta.queued);
	const view = {
		...heldView,
		items: sameItems(shown, held.view.items) ? held.view.items : shown,
		turnStatus: delta.row.turnStatus,
		workspaceId: delta.row.workspaceId,
		listedModelId: delta.row.listedModelId,
		selectedBranch: delta.row.selectedBranch ?? undefined,
		...(keepsUsage ? { usage: recordedContextUsage(items) } : {}),
	} as View;
	return { view, queuedCount: shown.length - items.length };
}

function lastIndexOfId(items: readonly SessionItem[], id: string) {
	for (let index = items.length - 1; index >= 0; index--)
		if (items[index].id === id) return index;
	return -1;
}

/** The same array contents: an unchanged poll keeps the view's own array. */
function sameItems(a: readonly SessionItem[], b: readonly SessionItem[]) {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}
