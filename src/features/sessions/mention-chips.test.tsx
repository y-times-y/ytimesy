import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { mentionAgents } from "#/domain/agent-mentions";
import { helperIdentitiesOf } from "#/domain/helper-names";
import { SessionItemId } from "#/domain/ids";
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
	expect(html).toContain('class="mention-chip"');
	expect(html).toContain("<span>build-1</span>");
	// Colour on the icon only.
	expect(html).toMatch(/mention-chip"[^>]*><svg[^>]*style="color:#FF8F96"/);
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
	expect(main).toContain("<span>build-1</span>");
	const helper = renderToStaticMarkup(
		<SessionTimeline
			items={items}
			turnStatus="completed"
			helperLines={{ identities }}
			taskParentId="w"
		/>,
	);
	expect(helper).toContain("<span>Main</span>");
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
