const INSPECTOR_SPLIT_MIN = 0.32;
const INSPECTOR_SPLIT_MAX = 0.72;
export const INSPECTOR_SPLIT_DEFAULT = 0.42;
export const CHAT_PANE_MIN_WIDTH = 320;
export const INSPECTOR_PANE_MIN_WIDTH = 360;
export function workspaceNeedsSinglePane(width: number): boolean {
	return width < CHAT_PANE_MIN_WIDTH + INSPECTOR_PANE_MIN_WIDTH + 4;
}
export const INSPECTOR_SPLIT_DESKTOP = 0.38;

export function clampInspectorSplit(ratio: number): number {
	if (!Number.isFinite(ratio)) return INSPECTOR_SPLIT_DEFAULT;
	return Math.min(INSPECTOR_SPLIT_MAX, Math.max(INSPECTOR_SPLIT_MIN, ratio));
}

export function inspectorPaneIsWide(view: string): boolean {
	return view === "desktop" || view === "files" || view === "canvas";
}

export function inspectorSplitRatio(input: {
	readonly custom: number | null;
	readonly wide: boolean;
}): number {
	if (input.custom !== null) return clampInspectorSplit(input.custom);
	return input.wide ? INSPECTOR_SPLIT_DESKTOP : INSPECTOR_SPLIT_DEFAULT;
}

/** The right panel's views (workspace-inspector.tsx's InspectorView). */
const INSPECTOR_VIEWS = [
	"overview",
	"files",
	"diff",
	"pr",
	"issues",
	"terminal",
	"desktop",
	"side",
	"canvas",
] as const;
export type SavedInspectorView = (typeof INSPECTOR_VIEWS)[number];

/**
 * The right panel as the user left it: open or closed, its tab and its
 * width. A cookie, so the server renders the page with it (the tab's
 * content is markup the browser cannot fix up before the first paint).
 */
export type SavedInspector = {
	readonly open: boolean;
	readonly view: SavedInspectorView;
	/** The chat's share of the width after a drag; null for the default. */
	readonly split: number | null;
};

export const INSPECTOR_COOKIE = "ytimesy-inspector";

export const CLOSED_INSPECTOR: SavedInspector = {
	open: false,
	view: "overview",
	split: null,
};

/** The saved panel from a Cookie header; anything unreadable is the closed panel. */
export function savedInspectorFromCookies(
	header: string | null | undefined,
): SavedInspector {
	const raw = header
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${INSPECTOR_COOKIE}=`))
		?.slice(INSPECTOR_COOKIE.length + 1);
	const [open, view, split] = decodeURIComponent(raw ?? "").split(".");
	if (open !== "1" && open !== "0") return CLOSED_INSPECTOR;
	const ratio = split ? Number(split) / 1000 : Number.NaN;
	// The side panel no longer has a Preview tab; a saved one opens on Desktop.
	const named = view === "preview" ? "desktop" : view;
	return {
		open: open === "1",
		view: INSPECTOR_VIEWS.find((known) => known === named) ?? "overview",
		split: Number.isFinite(ratio) ? clampInspectorSplit(ratio) : null,
	};
}

/** The cookie that keeps the panel as it is for the next page load. */
export function savedInspectorCookie(saved: SavedInspector): string {
	const split = saved.split === null ? "" : Math.round(saved.split * 1000);
	return `${INSPECTOR_COOKIE}=${saved.open ? 1 : 0}.${saved.view}.${split}; path=/; max-age=31536000; samesite=lax`;
}
