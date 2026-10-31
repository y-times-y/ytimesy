import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
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

const { SideChatFrame } = await import("./side-chat-panel");

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
	const pane = renderToStaticMarkup(
		<SideChatFrame parentTurnStatus="running">
			<p>Main chat composer</p>
		</SideChatFrame>,
	);
	expect(pane).toContain('aria-label="Side chat"');
	expect(pane).toContain("Main is working. This chat does not interrupt it.");
	// The side chat holds the same chat view as Main, not a separate form.
	expect(pane).toContain("Main chat composer");
});
