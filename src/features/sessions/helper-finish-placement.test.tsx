import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentTaskActivity } from "#/domain/child-task-activity";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { SessionTimeline } from "./session-timeline";

const PARENT = "11111111-1111-4111-8111-111111111111";

const helper = {
	id: "22222222-2222-4222-8222-222222222222",
	parentSessionId: PARENT,
	title: "Research the parser",
	label: "research",
	depth: 1,
	status: "done",
	prompt: "Research the parser",
	placement: "shared",
	access: "read",
	summary: "Found it.",
	harnessId: "api",
	listedModelId: null,
	createdAt: new Date(10).toISOString(),
	updatedAt: new Date(200).toISOString(),
	items: [],
	turnStatus: "completed",
} as unknown as AgentTaskActivity;

const main: SessionItem[] = [
	{
		kind: "userMessage",
		id: SessionItemId("p1"),
		text: "Look into the parser",
		timing: { startedAt: 1, completedAt: 100 },
	},
	{
		kind: "dynamicToolCall",
		id: SessionItemId("spawn"),
		tool: "agent",
		input: "{}",
		status: "completed",
	},
	{
		kind: "agentMessage",
		id: SessionItemId("answer"),
		text: "Main earlier answer",
	},
	{ kind: "notice", id: SessionItemId("wake"), message: "", wake: true },
];

const finishBelowAnswer = (html: string) => {
	const finish = html.indexOf('data-kind="helper-finish"');
	expect(finish).toBeGreaterThan(-1);
	return finish > html.indexOf("Main earlier answer");
};

it("shows a helper's finish line under Main's earlier answer while the report's turn runs, as after it ends", () => {
	const live = renderToStaticMarkup(
		<SessionTimeline
			items={main}
			turnStatus="running"
			tasks={[helper]}
			autoScroll={false}
		/>,
	);
	expect(finishBelowAnswer(live)).toBe(true);
	const ended = renderToStaticMarkup(
		<SessionTimeline
			items={[
				...main,
				{
					kind: "agentMessage",
					id: SessionItemId("reply"),
					text: "From the report",
				},
			]}
			turnStatus="completed"
			tasks={[helper]}
			autoScroll={false}
		/>,
	);
	expect(finishBelowAnswer(ended)).toBe(true);
});

it("puts the finish card above Main's reply to the report, with the report's first line", () => {
	const html = renderToStaticMarkup(
		<SessionTimeline
			items={[
				...main,
				{
					kind: "agentMessage",
					id: SessionItemId("reply"),
					text: "From the report",
				},
			]}
			turnStatus="completed"
			tasks={[helper]}
			helperLines={{
				identities: new Map([
					[
						helper.id,
						{
							name: "research-1",
							task: "Research the parser",
							icon: "search" as const,
							color: "#F43F5E",
						},
					],
				]),
				onSelect: () => {},
			}}
			autoScroll={false}
		/>,
	);
	const card = html.indexOf('class="helper-card"');
	expect(card).toBeGreaterThan(html.indexOf("Main earlier answer"));
	expect(card).toBeLessThan(html.indexOf("From the report"));
	expect(html).toContain('<span class="helper-card-name">research-1</span>');
	expect(html).toContain('<span class="helper-card-line">Found it.</span>');
});
