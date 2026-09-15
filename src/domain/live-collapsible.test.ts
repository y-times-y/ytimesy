import { describe, expect, it } from "vitest";
import {
	liveCollapsibleIsOpen,
	openedByUserAfterLiveChange,
	openedByUserFromToggle,
} from "./live-collapsible";

describe("live collapsible", () => {
	it("stays open while live even if the user has not expanded it", () => {
		expect(liveCollapsibleIsOpen(true, false)).toBe(true);
		expect(liveCollapsibleIsOpen(true, true)).toBe(true);
	});

	it("stays collapsed after the live phase unless the user uncollapses", () => {
		expect(liveCollapsibleIsOpen(false, false)).toBe(false);
		expect(liveCollapsibleIsOpen(false, true)).toBe(true);
	});

	it("ignores toggle clicks while live so the group cannot close mid-stream", () => {
		expect(openedByUserFromToggle(true, false, false)).toBe(false);
		expect(openedByUserFromToggle(true, true, false)).toBe(false);
	});

	it("records uncollapse after the live phase ends", () => {
		expect(openedByUserFromToggle(false, true, false)).toBe(true);
		expect(openedByUserFromToggle(false, false, true)).toBe(false);
	});

	it("collapses when a live phase ends so inspection is an explicit uncollapse", () => {
		expect(openedByUserAfterLiveChange(false, true, true)).toBe(false);
		expect(openedByUserAfterLiveChange(false, true, false)).toBe(false);
	});

	it("keeps the user's inspect state while live is unchanged", () => {
		expect(openedByUserAfterLiveChange(false, false, true)).toBe(true);
		expect(openedByUserAfterLiveChange(true, true, false)).toBe(false);
		expect(openedByUserAfterLiveChange(true, false, true)).toBe(true);
	});
});
