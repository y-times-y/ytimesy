import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import {
	keepRowsAboveInPlace,
	MOUNTED_END_ROWS,
	type TranscriptEntry,
	VirtualTranscript,
} from "./virtual-transcript";

const entries = (count: number): TranscriptEntry[] =>
	Array.from({ length: count }, (_, index) => ({
		key: `row-${index}`,
		kind: index % 2 ? "agentMessage" : "userMessage",
		follows: index ? (index % 2 ? "userMessage" : "agentMessage") : undefined,
		estimate: 50,
		content: <p>message {index}</p>,
	}));

it("paints the newest rows, with room for the older ones above them", () => {
	const html = renderToString(<VirtualTranscript entries={entries(100)} />);
	const keys = [...html.matchAll(/data-key="(row-\d+)"/g)].map(
		(match) => match[1],
	);
	expect(keys).toHaveLength(MOUNTED_END_ROWS);
	expect(keys[0]).toBe(`row-${100 - MOUNTED_END_ROWS}`);
	expect(keys.at(-1)).toBe("row-99");
	// The rows not mounted keep their estimated room, so the end paints in place.
	expect(html).toContain(`height:${(100 - MOUNTED_END_ROWS) * 50}px`);
	// Spacing that depends on the row above holds without that row mounted.
	expect(html).toContain(
		'data-key="row-61" data-kind="agentMessage" data-follows="userMessage"',
	);
});

it("paints every row of a short transcript, and a fixed first row above them", () => {
	const html = renderToString(
		<VirtualTranscript
			entries={entries(3)}
			first={{ kind: "older", height: 28, content: null }}
		/>,
	);
	expect(html.match(/data-key="row-/g)).toHaveLength(3);
	expect(html).toContain('data-kind="older"');
	expect(html).not.toContain("height:");
});

it("paints every row laid out, each keeping its estimated room for when it is skipped later", () => {
	const html = renderToString(<VirtualTranscript entries={entries(3)} />);
	// Rows away from the view are skipped only once hydrated.
	expect(html).not.toContain("data-skip-offscreen");
	expect(html.match(/contain-intrinsic-size:auto 50px/g)).toHaveLength(3);
});

it("keeps the row being read in place as rows above it change, whichever way the reader scrolls", () => {
	const list = {
		scrollOffset: 1_000,
		scrollAdjustments: 0,
		scrollDirection: "backward",
		itemSizeCache: new Map([
			["above", 300],
			["spanning", 300],
		]),
	} as unknown as Virtualizer<HTMLOListElement, Element>;
	const item = (key: string, start: number, size: number): VirtualItem => ({
		key,
		index: 0,
		start,
		size,
		end: start + size,
		lane: 0,
	});
	// Measured again (a skipped row laid out as it nears the view): wholly above.
	expect(keepRowsAboveInPlace(item("above", 400, 300), 120, list)).toBe(true);
	// Measured again across the top of the view: it changes below the reader's line.
	expect(keepRowsAboveInPlace(item("spanning", 900, 300), 120, list)).toBe(
		false,
	);
	// First measured: its estimate held the room above the view.
	expect(keepRowsAboveInPlace(item("new", 900, 300), 120, list)).toBe(true);
	expect(keepRowsAboveInPlace(item("below", 1_200, 300), 120, list)).toBe(
		false,
	);
});
