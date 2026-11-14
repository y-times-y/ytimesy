/**
 * Composer text kept in this browser across reloads: one draft per chat, and
 * one for the new-chat composer. Only the text; pasted-text attachments are
 * not kept. Drafts older than DRAFT_MAX_AGE_MS are dropped.
 *
 * draftFromStorage and storageWithDraft are self-contained (no closures, no
 * imports): the first-paint script inlines draftFromStorage.
 */
export const COMPOSER_DRAFTS_KEY = "ytimesy-composer-drafts";
export const NEW_CHAT_DRAFT_KEY = "new";
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The draft saved for this chat, or "" (none, stale, or unreadable). */
export function draftFromStorage(
	raw: string | null,
	chatKey: string,
	nowMs: number,
	maxAgeMs: number,
): string {
	try {
		const drafts = raw ? JSON.parse(raw) : null;
		const draft = drafts?.[chatKey];
		if (
			typeof draft?.text !== "string" ||
			typeof draft.at !== "number" ||
			nowMs - draft.at > maxAgeMs
		)
			return "";
		return draft.text;
	} catch {
		return "";
	}
}

/** The stored drafts with this chat's text set (or removed when blank) and stale ones dropped. */
export function storageWithDraft(
	raw: string | null,
	chatKey: string,
	text: string,
	nowMs: number,
	maxAgeMs: number,
): string {
	let drafts: Record<string, { text: string; at: number }> = {};
	try {
		const parsed = raw ? JSON.parse(raw) : null;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			drafts = parsed;
	} catch {
		// Unreadable: start over.
	}
	const kept: Record<string, { text: string; at: number }> = {};
	for (const [key, draft] of Object.entries(drafts)) {
		if (
			key !== chatKey &&
			typeof draft?.text === "string" &&
			typeof draft.at === "number" &&
			nowMs - draft.at <= maxAgeMs
		)
			kept[key] = draft;
	}
	if (text.trim()) kept[chatKey] = { text, at: nowMs };
	return JSON.stringify(kept);
}

/** The draft key of a composer: its chat, or the new-chat composer. */
/** The message box after a prefill: the text, or after what is typed when appending. */
export function draftWithPrefill(
	current: string,
	text: string,
	append: boolean,
): string {
	return append && current.trim() ? `${current.trimEnd()}\n\n${text}` : text;
}

export function composerDraftKey(chatId: string | null | undefined) {
	return chatId || NEW_CHAT_DRAFT_KEY;
}

/** This browser's saved draft for the chat; "" on the server or without storage. */
export function loadComposerDraft(chatKey: string): string {
	try {
		return draftFromStorage(
			window.localStorage.getItem(COMPOSER_DRAFTS_KEY),
			chatKey,
			Date.now(),
			DRAFT_MAX_AGE_MS,
		);
	} catch {
		return "";
	}
}

export function saveComposerDraft(chatKey: string, text: string) {
	try {
		const storage = window.localStorage;
		storage.setItem(
			COMPOSER_DRAFTS_KEY,
			storageWithDraft(
				storage.getItem(COMPOSER_DRAFTS_KEY),
				chatKey,
				text,
				Date.now(),
				DRAFT_MAX_AGE_MS,
			),
		);
	} catch {
		// Without storage the draft lasts as long as the page.
	}
}

/**
 * Saves a composer's drafts a moment after typing stops. Each pending save
 * keeps the chat it was typed in: when the composer moves to another chat
 * (New chat's chat gets its id, a switch, a send), the pending text is
 * saved at once under the chat it belongs to, never under the next one.
 */
export type DraftSaver = {
	/** Text typed in this chat; blank text (a send) is saved at once. */
	readonly typed: (chatKey: string, text: string) => void;
	/** Saves the pending text now. */
	readonly flush: () => void;
};

export function createDraftSaver(
	save: (chatKey: string, text: string) => void,
	delayMs: number,
	timers: {
		readonly set: (run: () => void, ms: number) => unknown;
		readonly clear: (timer: unknown) => void;
	} = {
		set: (run, ms) => setTimeout(run, ms),
		clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
	},
): DraftSaver {
	let pending: { chatKey: string; text: string; timer: unknown } | null = null;
	function flush() {
		if (!pending) return;
		const { chatKey, text, timer } = pending;
		pending = null;
		timers.clear(timer);
		save(chatKey, text);
	}
	return {
		typed(chatKey, text) {
			if (pending?.chatKey !== chatKey) flush();
			else if (pending) {
				timers.clear(pending.timer);
				pending = null;
			}
			if (!text.trim()) {
				save(chatKey, text);
				return;
			}
			pending = { chatKey, text, timer: timers.set(flush, delayMs) };
		},
		flush,
	};
}
