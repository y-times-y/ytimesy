import { describe, expect, it } from "vitest";
import {
	clampInspectorSplit,
	INSPECTOR_SPLIT_DEFAULT,
	INSPECTOR_SPLIT_DESKTOP,
	inspectorPaneIsWide,
	inspectorSplitRatio,
	workspaceNeedsSinglePane,
} from "./inspector-split";

describe("inspector split", () => {
	it("gives the workspace more room by default", () => {
		expect(INSPECTOR_SPLIT_DEFAULT).toBe(0.42);
	});
	it("switches based on both pane minimums and the divider", () => {
		expect(workspaceNeedsSinglePane(683)).toBe(true);
		expect(workspaceNeedsSinglePane(684)).toBe(false);
		expect(workspaceNeedsSinglePane(900)).toBe(false);
	});

	it("gives the desktop more of the canvas until the user drags", () => {
		expect(inspectorPaneIsWide("diff")).toBe(false);
		expect(inspectorPaneIsWide("files")).toBe(true);
		expect(inspectorPaneIsWide("desktop")).toBe(true);
		expect(inspectorSplitRatio({ custom: null, wide: false })).toBe(
			INSPECTOR_SPLIT_DEFAULT,
		);
		expect(inspectorSplitRatio({ custom: null, wide: true })).toBe(
			INSPECTOR_SPLIT_DESKTOP,
		);
		expect(inspectorSplitRatio({ custom: 0.6, wide: true })).toBe(0.6);
	});

	it("keeps the conversation and tools both usable", () => {
		expect(clampInspectorSplit(0.1)).toBe(0.32);
		expect(clampInspectorSplit(0.9)).toBe(0.72);
	});
});
