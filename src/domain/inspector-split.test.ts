import { describe, expect, it } from "vitest";
import {
	CLOSED_INSPECTOR,
	clampInspectorSplit,
	INSPECTOR_SPLIT_DEFAULT,
	INSPECTOR_SPLIT_DESKTOP,
	inspectorPaneIsWide,
	inspectorSplitRatio,
	savedInspectorCookie,
	savedInspectorFromCookies,
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

describe("saved right panel", () => {
	it("comes back as it was written", () => {
		const saved = { open: true, view: "files", split: 0.55 } as const;
		const cookie = savedInspectorCookie(saved).split(";")[0];
		expect(savedInspectorFromCookies(`a=1; ${cookie}; b=2`)).toEqual(saved);
		const closed = { open: false, view: "diff", split: null } as const;
		expect(
			savedInspectorFromCookies(savedInspectorCookie(closed).split(";")[0]),
		).toEqual(closed);
	});

	it("is the closed panel when missing or unreadable", () => {
		expect(savedInspectorFromCookies(null)).toEqual(CLOSED_INSPECTOR);
		expect(savedInspectorFromCookies("ytimesy-inspector=junk")).toEqual(
			CLOSED_INSPECTOR,
		);
		expect(savedInspectorFromCookies("ytimesy-inspector=1.nope.9999")).toEqual({
			open: true,
			view: "overview",
			split: 0.72,
		});
	});
});
