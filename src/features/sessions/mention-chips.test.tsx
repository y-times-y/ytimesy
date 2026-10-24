import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { mentionAgents } from "#/domain/agent-mentions";
import { helperIdentitiesOf } from "#/domain/helper-names";
import { SessionItemId } from "#/domain/ids";
import { AgentMentionContext } from "./agent-chip";
import { AgentMarkdown } from "./agent-markdown-renderer";
import { MentionPopover } from "./mention-popover";
import { SessionTimeline } from "./session-timeline";

const identities = helperIdentitiesOf([
	{
		id: "w",
		createdAt: "2026-10-21T10:00:00Z",
		kind: "writer",
		title: "Fix pricing rounding",
	},
]);

it("shows a sent message's mentions of the chat's agents as chips", () => {
	const html = renderToStaticMarkup(
		<SessionTimeline
			items={[
				{
					kind: "userMessage",
					id: SessionItemId("u1"),
					text: "Is @build-1 done? Not @build-7.",
				},
			]}
			turnStatus="completed"
			helperLines={{ identities }}
		/>,
	);
	expect(html).toContain('class="session-file-chip agent-chip"');
	expect(html).toContain('<span class="session-file-name">build-1</span>');
	// Colour on the icon only.
	expect(html).toMatch(/agent-chip"[^>]*><svg[^>]*style="color:#FF8F96"/);
	expect(html).toContain("@build-7");
});

it("never chips the agent whose view it is", () => {
	const items = [
		{
			kind: "userMessage" as const,
			id: SessionItemId("u1"),
			text: "@Main and @build-1",
		},
	];
	const main = renderToStaticMarkup(
		<SessionTimeline
			items={items}
			turnStatus="completed"
			helperLines={{ identities }}
		/>,
	);
	expect(main).toContain("@Main");
	expect(main).toContain('<span class="session-file-name">build-1</span>');
	const helper = renderToStaticMarkup(
		<SessionTimeline
			items={items}
			turnStatus="completed"
			helperLines={{ identities }}
			taskParentId="w"
		/>,
	);
	expect(helper).toContain('<span class="session-file-name">Main</span>');
	expect(helper).toContain("@build-1");
});

it("lists Main and the helpers with their tasks in the popover", () => {
	const html = renderToStaticMarkup(
		<MentionPopover
			agents={mentionAgents(identities, "none")}
			activeIndex={1}
			onHover={() => {}}
			onSelect={() => {}}
		/>,
	);
	expect(html).toContain("Main");
	expect(html).toContain("build-1");
	expect(html).toContain("Fix pricing rounding");
	expect(html).toMatch(/aria-selected="true"[^>]*>.*build-1/);
});

const names = identitiesFor(["Fix pricing rounding", "Find the export API"]);

function identitiesFor(titles: string[]) {
	return helperIdentitiesOf(
		titles.map((title, index) => ({
			id: `h${index}`,
			createdAt: `2026-10-21T10:0${index}:00Z`,
			kind: index ? ("researcher" as const) : ("writer" as const),
			title,
		})),
	);
}

function reply(text: string, view = "main") {
	const opened: string[] = [];
	const html = renderToStaticMarkup(
		<AgentMentionContext.Provider
			value={{
				agents: mentionAgents(names, view),
				onOpen: (agent) => opened.push(agent.id),
			}}
		>
			<AgentMarkdown text={text} onOpenFile={() => {}} />
		</AgentMentionContext.Provider>,
	);
	return html;
}

it("chips the chat's agents in a reply like files, and opens them", () => {
	const html = reply(
		"build-1 fixed `src/cart.ts`; @research-1 and `build-1` agree. Main waits.",
	);
	expect(html.match(/title="Open build-1/g)).toHaveLength(2);
	expect(html).toContain('title="Open research-1 · Find the export API"');
	expect(html).toContain('title="Open src/cart.ts"');
	// Main's own reply never chips Main.
	expect(html).not.toContain('<span class="session-file-name">Main</span>');
});

it("leaves names in code blocks, links, paths and longer words alone", () => {
	const html = reply(
		"```\nbuild-1\n```\n\nSee https://x.dev/build-1 and docs/build-1.md, build-10, rebuild-1.",
	);
	expect(html).not.toContain("agent-chip");
});

it("chips Main in a helper's reply, never the helper itself", () => {
	const html = reply("Main asked build-1 to check with research-1.", "h0");
	expect(html).toContain('<span class="session-file-name">Main</span>');
	expect(html).toContain('<span class="session-file-name">research-1</span>');
	expect(html).not.toContain('<span class="session-file-name">build-1</span>');
});
