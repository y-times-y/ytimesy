import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "#/domain/projects";
import { SIDEBAR_SORT_KEY } from "#/domain/sidebar-chats";
import { ProjectSidebar } from "./project-sidebar";

const project = (id: string, name: string): Project => ({
	id,
	name,
	repositoryId: 1,
	installationId: 1,
	fullName: `acme/${id}`,
	branch: "main",
});
const alpha = project("alpha", "Alpha");
const beta = project("beta", "Beta");
const projectChats = [
	{
		project: alpha,
		chats: [
			{ id: "a1", title: "Older chat", updatedAt: "2026-10-01T00:00:00Z" },
		],
	},
	{
		project: beta,
		chats: [
			{ id: "b1", title: "Newest chat", updatedAt: "2026-10-19T00:00:00Z" },
		],
	},
];

function render(stored: string | null) {
	(globalThis as { window?: unknown }).window = {
		localStorage: {
			getItem: (key: string) => (key === SIDEBAR_SORT_KEY ? stored : null),
			setItem: () => undefined,
		},
	};
	return renderToStaticMarkup(
		<ProjectSidebar
			projects={[alpha, beta]}
			projectsLoading={false}
			selectedProjectId="alpha"
			onSelectProject={() => undefined}
			expanded
			onToggle={() => undefined}
			onAddProject={() => undefined}
			chats={projectChats[0].chats}
			onNewChat={() => undefined}
			projectChats={projectChats}
			onOpenMemory={() => undefined}
			memoryActive
		/>,
	);
}

afterEach(() => {
	delete (globalThis as { window?: unknown }).window;
});

describe("left sidebar", () => {
	it("has a Memory entry in the sidebar and the rail", () => {
		const html = render(null);
		expect(html).toMatch(/class="sidebar-nav-item" aria-current="page"/);
		expect(html).toContain(">Memory</button>");
		expect(html).toContain('aria-label="Memory"');
	});

	it("groups by project by default, the most recently active project first", () => {
		const html = render(null);
		expect(html).toMatch(/aria-pressed="true"[^>]*>Projects</);
		expect(html.indexOf(">Beta<")).toBeLessThan(html.indexOf(">Alpha<"));
		expect(html).not.toContain("sidebar-chat-project");
	});

	it("lists every chat newest first with its project in Recent mode", () => {
		const html = render("recent");
		expect(html).toMatch(/aria-pressed="true"[^>]*>Recent</);
		expect(html.indexOf("Newest chat")).toBeLessThan(
			html.indexOf("Older chat"),
		);
		expect(html).toContain('<span class="sidebar-chat-project">Beta</span>');
		expect(html).toContain('<span class="sidebar-chat-project">Alpha</span>');
		expect(html).not.toContain("sidebar-folder-row");
	});
});
