/**
 * The Canvas viewer's camera: one document laid out at its natural size,
 * moved and scaled by a CSS transform (so text stays crisp), the way a
 * design tool's infinite canvas works. Pure arithmetic, no DOM.
 *
 * A view maps a point of the document to the panel: panel = view.{x,y} +
 * document * view.zoom. Pinned notes use the same mapping (anchorBox), so
 * they stay on their elements however the camera moves.
 */

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;
/** Space kept around the design when it is fitted to the panel. */
export const FIT_MARGIN = 32;

export type CanvasView = {
	readonly zoom: number;
	/** Where the document's origin is in the panel, in panel pixels. */
	readonly x: number;
	readonly y: number;
};

export type Size = { readonly width: number; readonly height: number };
export type Point = { readonly x: number; readonly y: number };
export type Box = Point & Size;

/** The zoom presets of the percentage menu; "fit" is its own entry. */
export const ZOOM_PRESETS = [0.5, 1, 2] as const;

/** What the viewer shows: fitted (the default) or a camera the user set. */
export type ViewMode =
	| { readonly kind: "fit" }
	| { readonly kind: "manual"; readonly view: CanvasView };

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return 1;
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** The zoom at which a design fits the panel, never enlarging past 100%. */
export function fitZoom(content: Size, panel: Size): number {
	if (
		content.width <= 0 ||
		content.height <= 0 ||
		panel.width <= 0 ||
		panel.height <= 0
	)
		return 1;
	const fit = Math.min(
		(panel.width - FIT_MARGIN * 2) / content.width,
		(panel.height - FIT_MARGIN * 2) / content.height,
	);
	// A panel narrower than the margins leaves nothing to fit into.
	if (!(fit > 0)) return ZOOM_MIN;
	return clampZoom(Math.min(1, fit));
}

/** The view that shows the whole content box, centred in the panel. */
export function fitView(content: Box, panel: Size): CanvasView {
	const zoom = fitZoom(content, panel);
	return {
		zoom,
		x: panel.width / 2 - (content.x + content.width / 2) * zoom,
		y: panel.height / 2 - (content.y + content.height / 2) * zoom,
	};
}

/** A view at this zoom with the document point under `at` left where it was. */
export function zoomAt(view: CanvasView, zoom: number, at: Point): CanvasView {
	const next = clampZoom(zoom);
	const ratio = next / view.zoom;
	return {
		zoom: next,
		x: at.x - (at.x - view.x) * ratio,
		y: at.y - (at.y - view.y) * ratio,
	};
}

export function panBy(view: CanvasView, dx: number, dy: number): CanvasView {
	return { ...view, x: view.x + dx, y: view.y + dy };
}

/**
 * The view moved back so that at least `reach` px of the content stays in
 * the panel: the design can be pushed to an edge, never lost off it.
 */
export function constrainView(
	view: CanvasView,
	content: Box,
	panel: Size,
	reach = 64,
): CanvasView {
	const left = view.x + content.x * view.zoom;
	const top = view.y + content.y * view.zoom;
	const right = left + content.width * view.zoom;
	const bottom = top + content.height * view.zoom;
	const keep = (low: number, high: number, extent: number) =>
		high < reach
			? reach - high
			: low > extent - reach
				? extent - reach - low
				: 0;
	const dx = keep(left, right, panel.width);
	const dy = keep(top, bottom, panel.height);
	return dx || dy ? panBy(view, dx, dy) : view;
}

const ZOOM_STEP = 1.25;

/** One button or key step in or out. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
	return clampZoom(direction > 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP);
}

/** How much one wheel or pinch event zooms by (bounded for coarse wheels). */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaMode === 1 ? deltaY * 16 : deltaY;
	return Math.min(2, Math.max(0.5, Math.exp(-pixels * 0.01)));
}

/** An element's place in the panel, from its place in the document. */
export function anchorBox(rect: Box, view: CanvasView): Box {
	return {
		x: view.x + rect.x * view.zoom,
		y: view.y + rect.y * view.zoom,
		width: rect.width * view.zoom,
		height: rect.height * view.zoom,
	};
}

/** The box around all artboards; null when the document declares none. */
export function artboardBounds(boards: readonly Box[]): Box | null {
	if (!boards.length) return null;
	const left = Math.min(...boards.map((board) => board.x));
	const top = Math.min(...boards.map((board) => board.y));
	const right = Math.max(...boards.map((board) => board.x + board.width));
	const bottom = Math.max(...boards.map((board) => board.y + board.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The camera the user last set on each canvas, for the page's life. */
const rememberedModes = new Map<string, ViewMode>();

export function rememberedMode(canvas: string): ViewMode {
	return rememberedModes.get(canvas) ?? { kind: "fit" };
}

export function rememberMode(canvas: string, mode: ViewMode) {
	if (mode.kind === "fit") rememberedModes.delete(canvas);
	else rememberedModes.set(canvas, mode);
}
