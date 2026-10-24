import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { FileTile, PastedTextTile, sentPasteFields } from "./attachment-tile";
import { SessionTimeline } from "./session-timeline";

it("shows a paste as a tile with its first lines, line count and remove button", () => {
	const html = renderToStaticMarkup(
		<ul>
			<PastedTextTile text={"alpha\n\nbeta\ngamma"} onRemove={() => {}} />
		</ul>,
	);
	expect(html).toContain("alpha\nbeta\ngamma");
	expect(html).toContain("Pasted · 4 lines");
	expect(html).toContain('aria-label="Remove pasted text"');
});

it("shows other files as tiles of the same kind", () => {
	const html = renderToStaticMarkup(
		<ul>
			<FileTile
				name="screen shot.png"
				mediaType="image/png"
				size={24_000}
				onRemove={() => {}}
			/>
		</ul>,
	);
	expect(html).toContain('class="attachment-tile" data-attachment="file"');
	expect(html).toContain("screen shot.png");
	expect(html).toContain("PNG · 23 KB");
	expect(html).toContain('aria-label="Remove screen shot.png"');
});

it("shows a sent paste as the same tile above the bubble, not its text", () => {
	const html = renderToStaticMarkup(
		<SessionTimeline
			turnStatus="completed"
			items={[
				{
					kind: "userMessage",
					id: SessionItemId("m1"),
					text: "Why is this slow?",
					attachments: [
						{
							id: "0f8fad5b-d9cb-469f-a165-70867728950e",
							name: "pasted-1.txt",
							mediaType: "text/plain",
							size: 4096,
							lines: 84,
							peek: "first line",
						},
					],
				},
			]}
		/>,
	);
	expect(html).toContain("Pasted · 84 lines");
	expect(html).toContain("first line");
	expect(html).not.toContain("pasted-1.txt");
	expect(html.indexOf("attachment-tiles")).toBeLessThan(
		html.indexOf("Why is this slow?"),
	);
	expect(html).not.toContain('aria-label="Remove');
});

it("keeps a sending paste's line count, first lines and text for its tile", () => {
	const text = "ünï\ncode\n";
	const base64 = Buffer.from(text).toString("base64");
	expect(
		sentPasteFields("0f8fad5b-d9cb-469f-a165-70867728950f", {
			name: "pasted-1.txt",
			mediaType: "text/plain",
			base64,
		}),
	).toEqual({ lines: 2, peek: "ünï\ncode" });
	const html = renderToStaticMarkup(
		<ul>
			<PastedTextTile attachmentId="0f8fad5b-d9cb-469f-a165-70867728950f" />
		</ul>,
	);
	expect(html).toContain("Pasted · 2 lines");
	expect(
		sentPasteFields("x", {
			name: "notes.txt",
			mediaType: "text/plain",
			base64,
		}),
	).toEqual({});
});
