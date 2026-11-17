import {
	createContext,
	useContext,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";
import {
	COMPOSER_DRAFTS_KEY,
	DRAFT_MAX_AGE_MS,
	draftFromStorage,
} from "#/domain/composer-drafts";
import { sidebarChatUnread } from "#/domain/sidebar-chat-status";
import {
	CHAT_SEEN_SINCE_STORAGE_KEY,
	CHAT_SEEN_STORAGE_KEY,
	chatsWithPinnedFirst,
	parsePinnedChatIds,
	parseSeenChatKeys,
	parseSeenSince,
	parseSidebarSort,
	SIDEBAR_COLLAPSED_PROJECTS_KEY,
	SIDEBAR_PINNED_CHATS_KEY,
	SIDEBAR_PINNED_STORAGE_KEY,
	SIDEBAR_SORT_KEY,
	type SidebarSort,
	sidebarIsPinnedInStorage,
} from "#/domain/sidebar-chats";
import { SIDEBAR_COLLAPSED_Y2_KEY } from "#/domain/sidebar-tree";
import { fitDraftHeight } from "../sessions/fit-draft-height";

/**
 * Layout choices only this browser knows (localStorage, the viewport). The
 * server cannot see them, so FIRST_PAINT_SCRIPT runs inline in <head> before
 * the first paint: it shows them through <html> data attributes and a small
 * stylesheet, and leaves them in window.__YT_BOOT__ so hydration starts from
 * the values the page already shows.
 * See .agents/skills/no-snap-first-paint/SKILL.md.
 */
export type FirstPaintChoices = {
	/** Phone-sized viewport: the sidebar is a drawer there. */
	readonly compact: boolean;
	/** The sidebar is pinned open; never on a phone, where it starts closed. */
	readonly sidebarOpen: boolean;
	readonly sidebarSort: SidebarSort;
	readonly collapsedProjectIds: readonly string[];
	/** Y projects whose threads are folded under their Y² row. */
	readonly collapsedY2ProjectIds: readonly string[];
	readonly pinnedChatIds: readonly string[];
};

declare global {
	interface Window {
		__YT_BOOT__?: FirstPaintChoices;
		/** The first-paint scripts' rules (saved pins, folds, unread replies), until React renders them. */
		__YT_BOOT_STYLES__?: CSSStyleSheet[];
		/** FIRST_PAINT_ROWS_SCRIPT's own sheet, among __YT_BOOT_STYLES__. */
		__YT_BOOT_ROWS__?: CSSStyleSheet;
	}
}

export const COMPACT_LAYOUT_QUERY =
	"(max-width: 600px), (max-width: 900px) and (max-height: 500px)";

/** What the server renders: nothing saved, a desktop viewport. */
export const SERVER_FIRST_PAINT: FirstPaintChoices = {
	compact: false,
	sidebarOpen: false,
	sidebarSort: "projects",
	collapsedProjectIds: [],
	collapsedY2ProjectIds: [],
	pinnedChatIds: [],
};

const STORAGE_KEYS = {
	sidebarPinned: SIDEBAR_PINNED_STORAGE_KEY,
	sidebarSort: SIDEBAR_SORT_KEY,
	collapsedProjects: SIDEBAR_COLLAPSED_PROJECTS_KEY,
	collapsedY2: SIDEBAR_COLLAPSED_Y2_KEY,
	pinnedChats: SIDEBAR_PINNED_CHATS_KEY,
};

/** Self-contained: inlined into the page, so it may use only its arguments and globals. */
export function readFirstPaintChoices(
	keys: typeof STORAGE_KEYS,
	compactQuery: string,
	parsePinned: (raw: string | null) => boolean,
	parseSort: (raw: string | null) => SidebarSort,
	parseIds: (raw: string | null) => readonly string[],
): FirstPaintChoices {
	function stored(key: string) {
		try {
			return window.localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	let compact = false;
	try {
		compact = window.matchMedia(compactQuery).matches;
	} catch {
		// No media queries: lay out for a desktop, as the server does.
	}
	return {
		compact,
		sidebarOpen: !compact && parsePinned(stored(keys.sidebarPinned)),
		sidebarSort: parseSort(stored(keys.sidebarSort)),
		collapsedProjectIds: parseIds(stored(keys.collapsedProjects)),
		collapsedY2ProjectIds: parseIds(stored(keys.collapsedY2)),
		pinnedChatIds: parseIds(stored(keys.pinnedChats)),
	};
}

/**
 * Self-contained, like readFirstPaintChoices. The sheet only sets custom
 * properties that styles.css reads (--chat-pinned, --folder-chats,
 * --folder-chevron, --y2-branch, --y2-chevron); React's own attributes replace it after hydration.
 */
export function showFirstPaintChoices(choices: FirstPaintChoices) {
	window.__YT_BOOT__ = choices;
	const root = document.documentElement;
	root.dataset.sidebar = choices.sidebarOpen ? "open" : "closed";
	root.dataset.sidebarSort = choices.sidebarSort;
	const plain = (id: string) => /^[\w-]+$/.test(id);
	const rules = choices.pinnedChatIds
		.filter(plain)
		.map((id) => `.sidebar-chat-row[data-chat-id="${id}"]{--chat-pinned:1}`)
		.concat(
			choices.collapsedProjectIds
				.filter(plain)
				.map(
					(id) =>
						`.sidebar-project[data-project-id="${id}"]{--folder-chats:none;--folder-chevron:none}`,
				),
		)
		.concat(
			choices.collapsedY2ProjectIds
				.filter(plain)
				.map(
					(id) =>
						`.sidebar-y2[data-project-id="${id}"]{--y2-branch:none;--y2-chevron:none;--y2-toggle-shown:1}`,
				),
		);
	if (!rules.length) return;
	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(rules.join(""));
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
		window.__YT_BOOT_STYLES__ = [...(window.__YT_BOOT_STYLES__ ?? []), sheet];
	} catch {
		// Without constructable sheets the saved pins show once React runs.
	}
}

/**
 * Self-contained, inlined right after the sidebar's server HTML: what needs
 * both the rows and this browser's storage. It marks unread replies from the
 * seen chats, and shows saved pins that sit past a fold (Recent's Done rows,
 * the finished threads under Y²). Rows carry data-seen-key, data-updated-at,
 * data-unread-mark, data-foldable and data-done-overflow while hydrating.
 */
export function markFirstPaintRows(
	keys: { readonly seen: string; readonly seenSince: string },
	parseSeen: (raw: string | null) => readonly string[],
	parseSince: (raw: string | null) => number | null,
	isUnread: typeof sidebarChatUnread,
	pinnedFirst: (
		chats: readonly { readonly id: string }[],
		pinnedIds: readonly string[],
	) => { readonly id: string }[],
) {
	function stored(key: string) {
		try {
			return window.localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	const seen = new Set(parseSeen(stored(keys.seen)));
	const seenSinceMs = parseSince(stored(keys.seenSince));
	const plain = (id: string) => /^[\w-]+$/.test(id);
	// This sidebar only: a streamed page can hold a second copy for a moment.
	const sidebar = document.currentScript?.previousElementSibling;
	if (!sidebar) return;
	const rows = (selector: string) =>
		Array.from(sidebar.querySelectorAll<HTMLElement>(selector)).filter((row) =>
			plain(row.dataset.chatId ?? ""),
		);
	const unread = (row: HTMLElement) =>
		isUnread({
			selected: false,
			running: false,
			turnStatus: "completed",
			updatedAt: row.dataset.updatedAt,
			seen: seen.has(row.dataset.seenKey ?? ""),
			seenSinceMs,
		});
	const rules: string[] = [];
	for (const row of rows("[data-unread-mark]")) {
		if (!unread(row)) continue;
		const chat = `.sidebar-chat-row[data-chat-id="${row.dataset.chatId}"][data-unread-mark]`;
		rules.push(
			`${chat} .sidebar-chat-age{display:none}`,
			`${chat} .sidebar-chat-trailing::after{display:block}`,
			`${chat} .sidebar-chat-title{color:var(--chat-unread-color);font-weight:var(--chat-unread-weight)}`,
		);
	}
	const folds = [
		{
			scope: ".sidebar-recent",
			rows: '[data-group="done"] .sidebar-chat-row',
		},
		{ scope: ".sidebar-y2-threads", rows: ".sidebar-chat-row[data-foldable]" },
	];
	for (const { scope, rows: rowsSelector } of folds) {
		const foldable = rows(`${scope} ${rowsSelector}`);
		const fold = foldable.filter((row) => !row.dataset.doneOverflow).length;
		const shown = new Set(
			pinnedFirst(
				foldable.map((row) => ({ id: row.dataset.chatId ?? "" })),
				window.__YT_BOOT__?.pinnedChatIds ?? [],
			)
				.slice(0, fold)
				.map((chat) => chat.id),
		);
		for (const row of foldable) {
			const id = row.dataset.chatId ?? "";
			if (shown.has(id) === !row.dataset.doneOverflow) continue;
			rules.push(
				`${scope} [data-chat-id="${id}"]{display:${shown.has(id) ? "flex" : "none"}}`,
			);
		}
	}
	// A page streamed in two copies (the latest chat read late) runs this
	// twice; the later copy is the one that stays, so its marks replace the
	// earlier ones.
	const earlier = window.__YT_BOOT_ROWS__;
	if (earlier) {
		earlier.replaceSync(rules.join(""));
		return;
	}
	if (!rules.length) return;
	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(rules.join(""));
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
		window.__YT_BOOT_STYLES__ = [...(window.__YT_BOOT_STYLES__ ?? []), sheet];
		window.__YT_BOOT_ROWS__ = sheet;
	} catch {
		// Without constructable sheets the marks show once React runs.
	}
}

export const FIRST_PAINT_SCRIPT = `(${showFirstPaintChoices})((${readFirstPaintChoices})(${JSON.stringify(STORAGE_KEYS)},${JSON.stringify(COMPACT_LAYOUT_QUERY)},${sidebarIsPinnedInStorage},${parseSidebarSort},${parsePinnedChatIds}))`;

export const FIRST_PAINT_ROWS_SCRIPT = `(${markFirstPaintRows})(${JSON.stringify({ seen: CHAT_SEEN_STORAGE_KEY, seenSince: CHAT_SEEN_SINCE_STORAGE_KEY })},${parseSeenChatKeys},${parseSeenSince},${sidebarChatUnread},${chatsWithPinnedFirst})`;

/**
 * Self-contained, inlined right after a server-rendered transcript list: it
 * paints scrolled to its end, and stays there as fonts and images load,
 * unless the reader scrolls first.
 */
export function showTimelineEnd() {
	const list = document.currentScript?.previousElementSibling;
	if (!list) return;
	// Only the reader stops it: the browser's own scroll anchoring moves
	// scrollTop too as fonts reflow the text.
	let read = false;
	for (const intent of ["wheel", "touchstart", "keydown", "pointerdown"])
		list.addEventListener(intent, () => (read = true), {
			once: true,
			passive: true,
		});
	const toEnd = () => {
		if (!read) list.lastElementChild?.scrollIntoView({ block: "end" });
	};
	toEnd();
	document.fonts?.ready.then(toEnd);
	// A streamed copy parses hidden and shows later, maybe after the load event.
	let shown: ResizeObserver | undefined;
	const settled = () => {
		if (!list.clientHeight) return;
		toEnd();
		if (document.readyState === "complete") shown?.disconnect();
	};
	window.addEventListener("load", settled, { once: true });
	try {
		shown = new ResizeObserver(settled);
		shown.observe(list);
	} catch {
		// No ResizeObserver: the page's own scroll runs once React does.
	}
}

export const TIMELINE_END_SCRIPT = `(${showTimelineEnd})()`;

/**
 * The id of an empty element right after the chat and right-panel panes. The
 * page's first paint waits until it is parsed (a render-blocking expect link
 * in __root.tsx), so a half-parsed page never paints: the chat full width
 * before the right panel arrives, its transcript at the top before the end.
 */
export const WORKSPACE_PANES_END = "workspace-panes-end";

/**
 * Self-contained, inlined right after the composer's server-rendered
 * textarea: it fills in this browser's saved draft for the textarea's chat
 * (data-draft-key) and sizes it, before the first paint. Hydration then
 * takes the text up like text typed before the scripts ran. Until then it
 * marks the textarea data-has-text while it holds text.
 */
export function restoreComposerDraft(
	storageKey: string,
	maxAgeMs: number,
	draftFor: typeof draftFromStorage,
	sizeToText: (input: HTMLTextAreaElement) => void,
) {
	const input = document.currentScript?.previousElementSibling;
	if (!(input instanceof HTMLTextAreaElement)) return;
	// data-has-text: the send button looks ready (styles.css) while it waits for React.
	const markText = () => {
		if (input.value.trim()) input.dataset.hasText = "";
		else delete input.dataset.hasText;
	};
	input.addEventListener("input", markText);
	if (!input.value) {
		let raw: string | null = null;
		try {
			raw = window.localStorage.getItem(storageKey);
		} catch {
			// No storage: nothing was saved.
		}
		const text = draftFor(
			raw,
			input.dataset.draftKey ?? "",
			Date.now(),
			maxAgeMs,
		);
		if (text) {
			input.value = text;
			sizeToText(input);
		}
	}
	markText();
}

export const COMPOSER_DRAFT_SCRIPT = `(${restoreComposerDraft})(${JSON.stringify(COMPOSER_DRAFTS_KEY)},${DRAFT_MAX_AGE_MS},${draftFromStorage},${fitDraftHeight})`;

export function readSavedChoices(): FirstPaintChoices {
	return readFirstPaintChoices(
		STORAGE_KEYS,
		COMPACT_LAYOUT_QUERY,
		sidebarIsPinnedInStorage,
		parseSidebarSort,
		parsePinnedChatIds,
	);
}

/** The <html> attribute styles.css lays the sidebar out from; React keeps it current. */
export function showSidebarOpen(open: boolean) {
	document.documentElement.dataset.sidebar = open ? "open" : "closed";
}

/** React now renders the saved pins, folds and unread marks itself. */
export function dropFirstPaintStyles() {
	const sheets = window.__YT_BOOT_STYLES__;
	if (!sheets) return;
	document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
		(adopted) => !sheets.includes(adopted),
	);
	window.__YT_BOOT_STYLES__ = undefined;
	window.__YT_BOOT_ROWS__ = undefined;
}

/** Lets tests render the after-hydration markup with the static renderer. */
export const RenderAsHydrated = createContext(false);

const subscribeToNothing = () => () => undefined;

/** True on the server and while React hydrates this component's server HTML. */
export function useHydrating(): boolean {
	return !useSyncExternalStore(
		subscribeToNothing,
		() => true,
		() => false,
	);
}

/**
 * False while React hydrates the server HTML, so a component renders exactly
 * the server markup; true from a layout effect right after, before the
 * browser paints. Components mounted later start true.
 */
export function useHydrated(): boolean {
	const asHydrated = useContext(RenderAsHydrated);
	const hydrating = useHydrating();
	const [hydrated, setHydrated] = useState(!hydrating);
	useLayoutEffect(() => setHydrated(true), []);
	return asHydrated || hydrated;
}

/**
 * The saved choices (on the server the defaults; while hydrating exactly what
 * the first paint showed; later read fresh) and whether to render them yet.
 */
export function useFirstPaint(): {
	readonly hydrated: boolean;
	readonly choices: FirstPaintChoices;
} {
	const hydrating = useHydrating();
	const [choices] = useState(() =>
		typeof window === "undefined"
			? SERVER_FIRST_PAINT
			: (hydrating && window.__YT_BOOT__) || readSavedChoices(),
	);
	return { hydrated: useHydrated(), choices };
}

/**
 * The value an input had when this component hydrated: text typed before the
 * page's scripts ran. Empty on the server and for later mounts.
 */
export function useTypedBeforeHydration(id: string): string {
	const hydrating = useHydrating();
	const [typed] = useState(() => {
		if (!hydrating || typeof document === "undefined") return "";
		const input = document.getElementById(id);
		return input instanceof HTMLInputElement ||
			input instanceof HTMLTextAreaElement
			? input.value
			: "";
	});
	return typed;
}
