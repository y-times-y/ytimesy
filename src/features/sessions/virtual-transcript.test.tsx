import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import {
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
