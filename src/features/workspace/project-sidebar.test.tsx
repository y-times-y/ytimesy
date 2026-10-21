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
		// One sort icon button (a menu) instead of a segmented control.
		expect(html).toContain('aria-label="Sort chats: Projects"');
		expect(html).not.toContain("sidebar-sort\"");
		expect(html.indexOf(">Beta<")).toBeLessThan(html.indexOf(">Alpha<"));
		expect(html).not.toContain("sidebar-chat-project");
	});

	it("lists every chat newest first with its project in Recent mode", () => {
		const html = render("recent");
		expect(html).toContain('aria-label="Sort chats: Recent"');
		expect(html.indexOf("Newest chat")).toBeLessThan(
			html.indexOf("Older chat"),
		);
		expect(html).toMatch(
			/class="sidebar-chat-project"><span class="sidebar-project-dot" style="background:#[0-9a-f]{6}" aria-hidden="true"><\/span><span>Beta<\/span>/,
		);
		expect(html).toContain("<span>Alpha</span>");
		expect(html).not.toContain("sidebar-folder-row");
		// Neither waits on the user nor runs: both are Done, with a count.
		expect(html).toMatch(
			/<span>Done<\/span><span class="sidebar-status-count">2<\/span>/,
		);
		expect(html).not.toContain("Needs you");
	});

	it("puts chats waiting on the user first, then running ones, then the rest", () => {
		const groups = [
			{
				project: alpha,
				chats: [
					{
						id: "a1",
						title: "Asks a question",
						updatedAt: "2026-10-01T00:00:00Z",
						waitingOn: "question" as const,
					},
					{
						id: "a2",
						title: "Busy chat",
						updatedAt: "2026-10-02T00:00:00Z",
						turnStatus: "running" as const,
					},
					...Array.from({ length: 10 }, (_, index) => ({
						id: `d${index}`,
						title: `Done chat ${index}`,
						updatedAt: `2026-10-0${3 + (index % 6)}T00:00:00Z`,
					})),
				],
			},
		];
		(globalThis as { window?: unknown }).window = {
			localStorage: {
				getItem: (key: string) => (key === SIDEBAR_SORT_KEY ? "recent" : null),
				setItem: () => undefined,
			},
		};
		const html = renderToStaticMarkup(
			<ProjectSidebar
				projects={[alpha]}
				projectsLoading={false}
				selectedProjectId="alpha"
				onSelectProject={() => undefined}
				expanded
				onToggle={() => undefined}
				onAddProject={() => undefined}
				chats={groups[0].chats}
				onNewChat={() => undefined}
				projectChats={groups}
			/>,
		);
		const needs = html.indexOf("Needs you");
		const working = html.indexOf("Working");
		const done = html.indexOf(">Done<");
		expect(needs).toBeGreaterThan(-1);
		expect(needs).toBeLessThan(working);
		expect(working).toBeLessThan(done);
		expect(html).toContain('data-activity="needs-you"');
		expect(html).toContain('data-activity="running"');
		expect(html).toContain("Show 2 more");
	});
});
