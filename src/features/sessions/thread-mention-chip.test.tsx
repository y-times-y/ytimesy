import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { threadDirectory } from "#/domain/thread-label";
import { MentionText } from "./agent-chip";
import { ReferenceContext, ThreadChip } from "./agent-reference-chips";

const ID = "3f9a2b1c-7d4e-4f10-9a55-0c2d8e6b1a77";
const threads = threadDirectory("ytimesy", [
	{ id: ID, title: "Fix login redirect", threadNumber: 12 },
]);

describe("a thread in chat text", () => {
	it("draws a thread chip with its Y in the thread's colour, its name and its title", () => {
		const html = renderToStaticMarkup(
			<ThreadChip
				id={ID}
				label="ytimesy-12"
				title="Fix login redirect"
				threadNumber={3}
			/>,
		);
		expect(html).toContain('class="thread-mark"');
		// Thread 3 takes the third agent colour.
		expect(html).toContain("--thread-color:#83C1FF");
		expect(html).not.toContain("thread-art");
		expect(html).toContain("ytimesy-12");
		expect(html).toContain(`href="/thread/${ID}"`);
	});

	it("turns a user's @mention of a known thread into that chip", () => {
		const html = renderToStaticMarkup(
			<ReferenceContext.Provider value={{ threads }}>
				<MentionText text="please look at @ytimesy-12 and @ytimesy-99" />
			</ReferenceContext.Provider>,
		);
		expect(html.match(/data-reference="thread"/g)).toHaveLength(1);
		// The Y and its colour come from the thread's number: 12 is the second.
		expect(html.match(/class="thread-mark"/g)).toHaveLength(1);
		expect(html).toContain("--thread-color:#9CD242");
		expect(html).not.toContain("thread-art");
		expect(html).toContain("Fix login redirect");
		// An unknown thread stays the words the person wrote.
		expect(html).toContain("@ytimesy-99");
	});

	it("leaves the text alone when the project has no such thread", () => {
		expect(renderToStaticMarkup(<MentionText text="hello @ytimesy-12" />)).toBe(
			"hello @ytimesy-12",
		);
	});
});
