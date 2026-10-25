import {
	createContext,
	useContext,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";
import {
	parsePinnedChatIds,
	parseSidebarSort,
	SIDEBAR_COLLAPSED_PROJECTS_KEY,
	SIDEBAR_PINNED_CHATS_KEY,
	SIDEBAR_PINNED_STORAGE_KEY,
	SIDEBAR_SORT_KEY,
	type SidebarSort,
	sidebarIsPinnedInStorage,
} from "#/domain/sidebar-chats";

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
	readonly pinnedChatIds: readonly string[];
};

declare global {
	interface Window {
		__YT_BOOT__?: FirstPaintChoices;
		/** FIRST_PAINT_SCRIPT's rules for saved pins and folded projects, until React renders them. */
		__YT_BOOT_STYLES__?: CSSStyleSheet;
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
	pinnedChatIds: [],
};

const STORAGE_KEYS = {
	sidebarPinned: SIDEBAR_PINNED_STORAGE_KEY,
	sidebarSort: SIDEBAR_SORT_KEY,
	collapsedProjects: SIDEBAR_COLLAPSED_PROJECTS_KEY,
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
		pinnedChatIds: parseIds(stored(keys.pinnedChats)),
	};
}

/**
 * Self-contained, like readFirstPaintChoices. The sheet only sets custom
 * properties that styles.css reads (--chat-pinned, --folder-chats,
 * --folder-chevron); React's own attributes replace it after hydration.
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
		);
	if (!rules.length) return;
	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(rules.join(""));
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
		window.__YT_BOOT_STYLES__ = sheet;
	} catch {
		// Without constructable sheets the saved pins show once React runs.
	}
}

export const FIRST_PAINT_SCRIPT = `(${showFirstPaintChoices})((${readFirstPaintChoices})(${JSON.stringify(STORAGE_KEYS)},${JSON.stringify(COMPACT_LAYOUT_QUERY)},${sidebarIsPinnedInStorage},${parseSidebarSort},${parsePinnedChatIds}))`;

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

/** React now renders the saved pins and folded projects itself. */
export function dropFirstPaintStyles() {
	const sheet = window.__YT_BOOT_STYLES__;
	if (!sheet) return;
	document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
		(adopted) => adopted !== sheet,
	);
	window.__YT_BOOT_STYLES__ = undefined;
}

/** Lets tests render the after-hydration markup with the static renderer. */
export const RenderAsHydrated = createContext(false);

const subscribeToNothing = () => () => undefined;

/** True on the server and while React hydrates this component's server HTML. */
function useHydrating(): boolean {
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
