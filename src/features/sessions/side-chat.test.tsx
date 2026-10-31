import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { slashCommandOpensSideChat } from "#/domain/side-chat";
import {
	composerSlashCommands,
	parseSlashDraft,
	slashMenuCommands,
} from "#/domain/slash-command";
import { SlashCommandPalette } from "./slash-command-palette";

vi.mock("./session-timeline", () => ({
	SessionTimeline: ({
		items,
	}: {
		items: readonly { readonly text?: string }[];
	}) => (
		<ol>
			{items.map((item) => (
				<li key={item.text}>{item.text}</li>
			))}
		</ol>
	),
}));

const { SideChatPane } = await import("./side-chat-panel");

const menu = slashMenuCommands(
	parseSlashDraft("/") ?? { query: "", argument: "" },
	composerSlashCommands({
		authenticated: true,
		requiresAccountLogin: true,
		turnRunning: true,
		canSend: false,
		hasLastUserMessage: true,
		hasModels: true,
	}),
);

it("lists /side in the slash menu and opens a side chat", () => {
	expect(menu.map((command) => command.trigger)).toContain("/side");
	const side = menu.find((command) => command.id === "side");
	expect(side && slashCommandOpensSideChat(side)).toBe(true);
	const html = renderToStaticMarkup(
		<SlashCommandPalette
			commands={menu}
			activeIndex={menu.findIndex((command) => command.id === "side")}
			onHover={() => {}}
			onSelect={() => {}}
		/>,
	);
	expect(html).toContain("/side");
	expect(html).toContain("Side");
	const items: SessionItem[] = [
		{
			kind: "agentMessage",
			id: SessionItemId("agent"),
			text: "Main is editing auth.",
		},
	];
	const pane = renderToStaticMarkup(
		<SideChatPane
			items={items}
			turnStatus="idle"
			parentTurnStatus="running"
			draft=""
			pending={false}
			error={null}
			canSend
			onDraft={() => {}}
			onSend={() => {}}
			onClose={() => {}}
		/>,
	);
	expect(pane).toContain('aria-label="Side chat"');
	expect(pane).toContain("Main is editing auth.");
	expect(pane).toContain("Main is working. This chat does not interrupt it.");
	expect(pane).toContain('aria-label="Close side chat"');
	expect(pane).toContain('aria-label="Send to side chat"');
	expect(pane).not.toContain("Stop this run");
});
