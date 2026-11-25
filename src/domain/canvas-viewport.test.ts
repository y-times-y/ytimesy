import { describe, expect, it } from "vitest";
import {
	anchorBox,
	artboardBounds,
	clampZoom,
	fitView,
	fitZoom,
	stepZoom,
	wheelZoomFactor,
	ZOOM_MAX,
	ZOOM_MIN,
	zoomAt,
} from "./canvas-viewport";

describe("clampZoom", () => {
	it("keeps zoom inside the limits and survives bad input", () => {
		expect(clampZoom(100)).toBe(ZOOM_MAX);
		expect(clampZoom(0)).toBe(ZOOM_MIN);
		expect(clampZoom(-3)).toBe(ZOOM_MIN);
		expect(clampZoom(Number.NaN)).toBe(1);
		expect(clampZoom(1.5)).toBe(1.5);
	});
});

describe("fitZoom", () => {
	const panel = { width: 600, height: 800 };
	it("fits two 1440 px artboards side by side into a narrow panel", () => {
		const zoom = fitZoom({ width: 3000, height: 900 }, panel);
		expect(zoom).toBeCloseTo((600 - 64) / 3000, 5);
	});
	it("fits by height when the design is tall", () => {
		expect(fitZoom({ width: 300, height: 2000 }, panel)).toBeCloseTo(
			(800 - 64) / 2000,
			5,
		);
	});
	it("never enlarges a small design past 100%", () => {
		expect(fitZoom({ width: 100, height: 100 }, panel)).toBe(1);
	});
	it("is 1 until the panel or the document is measured", () => {
		expect(fitZoom({ width: 0, height: 0 }, panel)).toBe(1);
		expect(fitZoom({ width: 500, height: 500 }, { width: 0, height: 0 })).toBe(
			1,
		);
	});
	it("does not go below the minimum zoom", () => {
		expect(fitZoom({ width: 1_000_000, height: 10 }, panel)).toBe(ZOOM_MIN);
	});
});

describe("fitView", () => {
	it("centres the content box in the panel", () => {
		const view = fitView(
			{ x: 100, y: 50, width: 1000, height: 500 },
			{ width: 600, height: 400 },
		);
		expect(view.zoom).toBeCloseTo(536 / 1000, 5);
		const centreX = view.x + (100 + 500) * view.zoom;
		const centreY = view.y + (50 + 250) * view.zoom;
		expect(centreX).toBeCloseTo(300, 5);
		expect(centreY).toBeCloseTo(200, 5);
	});
});

describe("zoomAt", () => {
	it("keeps the document point under the cursor fixed", () => {
		const view = { zoom: 0.5, x: 40, y: 20 };
		const cursor = { x: 300, y: 200 };
		const docPoint = {
			x: (cursor.x - view.x) / view.zoom,
			y: (cursor.y - view.y) / view.zoom,
		};
		const next = zoomAt(view, 2, cursor);
		expect(next.zoom).toBe(2);
		expect(next.x + docPoint.x * next.zoom).toBeCloseTo(cursor.x, 5);
		expect(next.y + docPoint.y * next.zoom).toBeCloseTo(cursor.y, 5);
	});
	it("clamps the requested zoom", () => {
		expect(zoomAt({ zoom: 1, x: 0, y: 0 }, 1000, { x: 0, y: 0 }).zoom).toBe(
			ZOOM_MAX,
		);
	});
});

describe("stepZoom", () => {
	it("steps up and down and stops at the limits", () => {
		expect(stepZoom(1, 1)).toBeGreaterThan(1);
		expect(stepZoom(1, -1)).toBeLessThan(1);
		expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
		expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
	});
});

describe("wheelZoomFactor", () => {
	it("zooms in for a pinch out (negative delta) and out for the reverse", () => {
		expect(wheelZoomFactor(-10, 0)).toBeGreaterThan(1);
		expect(wheelZoomFactor(10, 0)).toBeLessThan(1);
	});
	it("is bounded for one huge mouse-wheel notch", () => {
		expect(wheelZoomFactor(-100000, 0)).toBeLessThanOrEqual(2);
		expect(wheelZoomFactor(100000, 0)).toBeGreaterThanOrEqual(0.5);
	});
});

describe("anchorBox", () => {
	const rect = { x: 100, y: 200, width: 300, height: 40 };
	it("puts a pinned element where the transformed content shows it", () => {
		const box = anchorBox(rect, { zoom: 0.5, x: 30, y: -10 });
		expect(box).toEqual({ x: 80, y: 90, width: 150, height: 20 });
	});
	it("stays on the same element through zoom then pan", () => {
		const cursor = { x: 250, y: 150 };
		const before = { zoom: 1, x: 0, y: 0 };
		const zoomed = zoomAt(before, 2, cursor);
		const box = anchorBox(rect, zoomed);
		// The element's own point under the cursor did not move.
		const docUnderCursor = { x: 250, y: 150 };
		const after = {
			x: zoomed.x + docUnderCursor.x * zoomed.zoom,
			y: zoomed.y + docUnderCursor.y * zoomed.zoom,
		};
		expect(after.x).toBeCloseTo(cursor.x, 5);
		expect(after.y).toBeCloseTo(cursor.y, 5);
		expect(box.width).toBe(600);
	});
});

describe("artboardBounds", () => {
	it("is the union of artboards, none present yields null", () => {
		expect(artboardBounds([])).toBeNull();
		expect(
			artboardBounds([
				{ x: 40, y: 40, width: 1440, height: 900 },
				{ x: 1560, y: 40, width: 1440, height: 900 },
			]),
		).toEqual({ x: 40, y: 40, width: 2960, height: 900 });
	});
});
