import { describe, expect, it } from "vitest";
import {
	clampInspectorSplit,
	INSPECTOR_SPLIT_DEFAULT,
	INSPECTOR_SPLIT_DESKTOP,
	inspectorSplitFromPointer,
	inspectorSplitRatio,
	inspectorStaysBesideChat,
	nudgeInspectorSplit,
} from "./inspector-split";

describe("inspector split", () => {
	it("keeps tools as a sidebar so the composer stays desktop-width", () => {
		expect(INSPECTOR_SPLIT_DEFAULT).toBe(0.66);
		expect(inspectorStaysBesideChat(false)).toBe(true);
		expect(inspectorStaysBesideChat(true)).toBe(false);
	});

	it("gives the desktop more of the canvas until the user drags", () => {
		expect(inspectorSplitRatio({ custom: null, desktop: false })).toBe(
			INSPECTOR_SPLIT_DEFAULT,
		);
		expect(inspectorSplitRatio({ custom: null, desktop: true })).toBe(
			INSPECTOR_SPLIT_DESKTOP,
		);
		expect(inspectorSplitRatio({ custom: 0.6, desktop: true })).toBe(0.6);
	});

	it("keeps the conversation and tools both usable", () => {
		expect(clampInspectorSplit(0.1)).toBe(0.32);
		expect(clampInspectorSplit(0.9)).toBe(0.72);
		expect(
			inspectorSplitFromPointer({
				clientX: 250,
				originX: 50,
				width: 400,
			}),
		).toBe(0.5);
		expect(nudgeInspectorSplit(0.5, -1)).toBe(0.47);
	});
});
