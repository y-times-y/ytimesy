import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mentionAgents, threadMentionAgents } from "#/domain/agent-mentions";
import { helperIdentitiesOf } from "#/domain/helper-names";
import { threadDirectory } from "#/domain/thread-label";
import { AgentMentionContext, MentionText } from "./agent-chip";
import { AgentMarkdown } from "./agent-markdown-renderer";
import { ReferenceContext } from "./agent-reference-chips";
import { MentionPopover } from "./mention-popover";

/**
 * A chat's own agents (helpers: "build-1") keep their own icon; only a real
 * thread gets the coloured Y. They read alike by name, so a project called
 * "build" has a thread "build-1" next to the chat's helper "build-1".
 */
const identities = helperIdentitiesOf([
	{
		id: "w",
		createdAt: "2026-10-21T10:00:00Z",
		kind: "writer",
		title: "Fix pricing rounding",
	},
]);
const agents = mentionAgents(identities, "main-self");
const THREAD_ID = "3f9a2b1c-7d4e-4f10-9a55-0c2d8e6b1a77";
const threads = threadDirectory("build", [
	{ id: THREAD_ID, title: "Speed up search", threadNumber: 1 },
	{ id: "7b1e44c2-0a6d-4c3f-8e21-5d9f3a6c0b12", title: "Add dark mode", threadNumber: 2 },
]);

function reply(text: string) {
	return renderToStaticMarkup(
		<AgentMentionContext.Provider value={{ agents }}>
			<ReferenceContext.Provider value={{ threads }}>
				<AgentMarkdown text={text} />
			</ReferenceContext.Provider>
		</AgentMentionContext.Provider>,
	);
}

describe("a subagent never shows the thread Y", () => {
	it("in a reply: the helper build-1 keeps its icon, though a thread is named build-1 too", () => {
		const html = reply("build-1 finished; build-2 is the dark mode thread.");
		expect(html).toContain('class="session-file-chip agent-chip"');
		expect(html).toMatch(/agent-chip"[^>]*><svg[^>]*style="color:#83C1FF"/);
		// build-2 is only a thread: the Y, in the second colour.
		expect(html.match(/class="thread-mark"/g)).toHaveLength(1);
		expect(html).toContain("--thread-color:#9CD242");
		expect(html).not.toContain(`/thread/${THREAD_ID}`);
	});

	it("in a user's message: the same", () => {
		const html = renderToStaticMarkup(
			<AgentMentionContext.Provider value={{ agents }}>
				<ReferenceContext.Provider value={{ threads }}>
					<MentionText text="ask @build-1 and @build-2" />
				</ReferenceContext.Provider>
			</AgentMentionContext.Provider>,
		);
		expect(html).toContain('class="session-file-chip agent-chip"');
		expect(html.match(/class="thread-mark"/g)).toHaveLength(1);
	});

	it("an explicit thread link still draws the thread, with its Y", () => {
		const html = reply(`See [Speed up search](thread:${THREAD_ID}).`);
		expect(html.match(/class="thread-mark"/g)).toHaveLength(1);
		expect(html).toContain("--thread-color:#83C1FF");
	});

	it("in the @ list: a helper row has its icon, a thread row has the Y", () => {
		const list = [
			...agents,
			...threadMentionAgents([
				{
					id: THREAD_ID,
					name: "build-1",
					title: "Speed up search",
					threadNumber: 1,
				},
			]),
		];
		const html = renderToStaticMarkup(
			<MentionPopover
				agents={list}
				activeIndex={0}
				onHover={() => {}}
				onSelect={() => {}}
			/>,
		);
		expect(html.match(/class="thread-mark"/g)).toHaveLength(1);
		expect(html).toContain("Fix pricing rounding");
	});
});
