import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { applyPlanUpdate } from "#/domain/agent-todos";
import { WorkspaceOverview } from "./workspace-overview";

it("shows workspace entry points without inventing progress or machine specs", () => {
	const html = renderToStaticMarkup(
		createElement(WorkspaceOverview, {
			tasks: [],
			items: [],
			changes: [],
			pullRequests: [],
			repository: "owner/project",
			desktop: { status: "stopped" },
			onOpen: () => {},
		}),
	);
	for (const title of [
		"Diffs",
		"Files",
		"Desktop",
		"Terminal",
		"owner/project",
		"Not running",
	])
		expect(html).toContain(title);
	expect(html.match(/<button/g)).toHaveLength(4);
	expect(html).not.toContain("vCPU");
	expect(html).not.toContain("completed");
	expect(html).not.toContain("New task");
});

it("shows the builder's latest plan update as the Todos checklist", () => {
	const first = applyPlanUpdate([], "turn", {
		plan: [
			{ step: "Read the schema", status: "in_progress" },
			{ step: "Write the migration", status: "pending" },
		],
	});
	const items = applyPlanUpdate(first, "turn", {
		plan: [
			{ step: "Read the schema", status: "completed" },
			{ step: "Write the migration", status: "in_progress" },
		],
	});
	const html = renderToStaticMarkup(
		createElement(WorkspaceOverview, {
			tasks: [],
			items,
			changes: [],
			pullRequests: [],
			desktop: { status: "stopped" },
			onOpen: () => {},
		}),
	);
	expect(html.match(/aria-label="Todos"/g)).toHaveLength(1);
	expect(html).toContain("1/2");
	expect(html).toContain("<s>Read the schema</s>");
	expect(html).toContain('data-status="in_progress"');
	expect(html).not.toContain("<h2>Plan</h2>");
});
