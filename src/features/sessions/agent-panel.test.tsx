import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type AgentPanelRow, LEAD_ROW_ID } from "#/domain/agent-panel";
import { KIND_ICONS } from "#/domain/helper-names";
import { AgentPanel } from "./agent-panel";

const row = (
	id: string,
	status: AgentPanelRow["status"],
	extra: Partial<AgentPanelRow> = {},
): AgentPanelRow => ({
	id,
	name: id,
	kind: "main",
	tag: null,
	icon: KIND_ICONS.main,
	color: "#fff",
	status,
	doing: "",
	queued: 0,
	title: id,
	messageable: false,
	...extra,
});

const text = (html: string) =>
	html
		.replace(/<!-- -->/g, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");

describe("the agents panel under the composer", () => {
	const lead = row(LEAD_ROW_ID, "working");
	const render = (helpers: AgentPanelRow[], background: AgentPanelRow[] = []) =>
		text(
			renderToStaticMarkup(
				<AgentPanel
					lead={lead}
					helpers={helpers}
					background={background}
					selectedId={LEAD_ROW_ID}
					onSelect={() => undefined}
				/>,
			),
		);

	it("counts Main and its helpers as agents, not background commands", () => {
		const html = render(
			[row("build-1", "working"), row("build-2", "done")],
			[row("cmd-1", "working"), row("cmd-2", "working")],
		);
		expect(html).toContain("3 agents");
		expect(html).toContain("2 working");
		expect(html).not.toContain("5 agents");
		expect(html).toContain("2 background running");
	});

	it("says how many background commands rest when none run", () => {
		const html = render([row("build-1", "done")], [row("cmd-1", "done")]);
		expect(html).toContain("2 agents");
		expect(html).toContain("1 background");
		expect(html).not.toContain("background running");
	});

	it("uses the singular for a lone agent with only a background command", () => {
		const html = render([], [row("cmd-1", "working")]);
		expect(html).toContain("1 agent ");
		expect(html).not.toContain("1 agents");
	});

	it("offers a way back to the folded form", () => {
		const html = render([row("build-1", "working")]);
		expect(html).toContain("Show less");
	});
});
