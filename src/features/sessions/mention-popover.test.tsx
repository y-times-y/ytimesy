import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	MAIN_MENTION_ID,
	mentionAgents,
	threadMentionAgents,
} from "#/domain/agent-mentions";
import { MentionPopover } from "./mention-popover";

describe("MentionPopover", () => {
	const agents = [
		...mentionAgents(new Map(), "someone-else"),
		...threadMentionAgents([
			{
				id: "3f9a2b1c-7d4e-4f10-9a55-0c2d8e6b1a77",
				name: "ytimesy-12",
				title: "Fix login redirect",
				threadNumber: 2,
			},
		]),
	];

	it("draws a thread with its name and title, and an agent with its icon", () => {
		const html = renderToStaticMarkup(
			<MentionPopover
				agents={agents}
				activeIndex={0}
				onHover={() => undefined}
				onSelect={() => undefined}
			/>,
		);
		expect(html).toContain('aria-label="Agents and threads"');
		expect(html).toContain("ytimesy-12");
		expect(html).toContain("Fix login redirect");
		// A thread has its Y in its colour (thread 2 is the second); no pictures.
		expect(html.match(/class="thread-mark"/g)).toHaveLength(1);
		expect(html).toContain("--thread-color:#9CD242");
		expect(html).not.toContain("thread-art");
		expect(html).toContain("Main");
		expect(agents[0]?.id).toBe(MAIN_MENTION_ID);
	});

	it("draws nothing without choices", () => {
		expect(
			renderToStaticMarkup(
				<MentionPopover
					agents={[]}
					activeIndex={0}
					onHover={() => undefined}
					onSelect={() => undefined}
				/>,
			),
		).toBe("");
	});
});
