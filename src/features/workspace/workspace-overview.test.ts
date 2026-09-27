import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
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
