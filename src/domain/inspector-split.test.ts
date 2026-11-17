import { describe, expect, it } from "vitest";
import {
	CLOSED_INSPECTOR,
	clampInspectorSplit,
	INSPECTOR_SPLIT_DEFAULT,
	INSPECTOR_SPLIT_DESKTOP,
	INSPECTOR_SPLIT_LIST,
	inspectorPaneIsWide,
	inspectorPaneWidth,
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
		expect(inspectorSplitRatio({ custom: null, pane: "default" })).toBe(
			INSPECTOR_SPLIT_DEFAULT,
		);
		expect(inspectorSplitRatio({ custom: null, pane: "wide" })).toBe(
			INSPECTOR_SPLIT_DESKTOP,
		);
		expect(inspectorSplitRatio({ custom: 0.6, pane: "wide" })).toBe(0.6);
	});

	it("gives Y²'s conversation more width than its overview list", () => {
		expect(inspectorPaneWidth({ view: "overview", ySquared: true })).toBe(
			"list",
		);
		expect(inspectorPaneWidth({ view: "overview", ySquared: false })).toBe(
			"default",
		);
		expect(inspectorPaneWidth({ view: "desktop", ySquared: true })).toBe(
			"wide",
		);
		const ratio = inspectorSplitRatio({ custom: null, pane: "list" });
		expect(ratio).toBe(INSPECTOR_SPLIT_LIST);
		// 1190px beside a 250px sidebar on a 1440px screen.
		expect(Math.round(1190 * (1 - ratio))).toBeLessThanOrEqual(440);
		expect(ratio).toBeGreaterThan(0.5);
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

	it("opens a saved Preview tab on Desktop", () => {
		expect(savedInspectorFromCookies("ytimesy-inspector=1.preview.")).toEqual({
			open: true,
			view: "desktop",
			split: null,
		});
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
