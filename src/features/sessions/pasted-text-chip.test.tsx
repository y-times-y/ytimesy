import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { PastedTextChip } from "./pasted-text-chip";
import { SessionTimeline } from "./session-timeline";

it("shows a paste as a chip with its line count and a remove button", () => {
	const html = renderToStaticMarkup(
		<ul>
			<PastedTextChip text={"a\nb\nc"} onRemove={() => {}} />
		</ul>,
	);
	expect(html).toContain("Pasted text");
	expect(html).toContain("3 lines");
	expect(html).toContain('aria-label="Remove pasted text"');
});

it("shows a sent paste as the same chip, not its text", () => {
	const html = renderToStaticMarkup(
		<SessionTimeline
			turnStatus="completed"
			items={[
				{
					kind: "userMessage",
					id: SessionItemId("m1"),
					text: "See the attached files.",
					attachments: [
						{
							id: "0f8fad5b-d9cb-469f-a165-70867728950e",
							name: "pasted-1.txt",
							mediaType: "text/plain",
							size: 4096,
							lines: 84,
						},
					],
				},
			]}
		/>,
	);
	expect(html).toContain("Pasted text");
	expect(html).toContain("84 lines");
	expect(html).not.toContain("pasted-1.txt</span>");
});
