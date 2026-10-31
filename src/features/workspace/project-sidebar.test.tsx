import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "#/domain/projects";
import {
	CHAT_SEEN_SINCE_STORAGE_KEY,
	SIDEBAR_SORT_KEY,
	type SidebarChat,
} from "#/domain/sidebar-chats";
import { RenderAsHydrated } from "../app/first-paint";
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

function render(stored: string | null, hydrated = true) {
	(globalThis as { window?: unknown }).window = {
		localStorage: {
			getItem: (key: string) => (key === SIDEBAR_SORT_KEY ? stored : null),
			setItem: () => undefined,
		},
	};
	return renderToStaticMarkup(
		<RenderAsHydrated value={hydrated}>
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
			/>
		</RenderAsHydrated>,
	);
}

afterEach(() => {
	delete (globalThis as { window?: unknown }).window;
});

describe("left sidebar", () => {
	it("has a Memory entry in the sidebar", () => {
		const html = render(null);
		expect(html).toMatch(/class="sidebar-nav-item" aria-current="page"/);
		expect(html).toContain(">Memory</button>");
		expect(html.match(/class="sidebar-nav-item"/g)).toHaveLength(1);
		expect(html).not.toContain("Memory graph");
	});

	it("has a top-left toggle for the closed sidebar, one in its header for the open one, and no rail", () => {
		const html = render(null);
		expect(html).toContain("left-sidebar-toggle");
		// The open sidebar's toggle sits in its header, after the logo.
		const header = html.slice(html.indexOf('class="sidebar-brand-row"'));
		expect(header.indexOf("brand-mark")).toBeLessThan(
			header.indexOf("sidebar-brand-toggle"),
		);
		expect(header.indexOf("sidebar-brand-toggle")).toBeLessThan(
			header.indexOf('class="sidebar-toolbar"'),
		);
		expect(html).not.toContain("sidebar-rail");
		expect(html.match(/class="brand-mark"/g)).toHaveLength(1);
	});

	it("groups by project by default, the most recently active project first", () => {
		const html = render(null);
		// One sort icon button (a menu) instead of a segmented control.
		expect(html).toContain('aria-label="Sort chats: Projects"');
		expect(html).not.toContain('sidebar-sort"');
		expect(html.indexOf(">Beta<")).toBeLessThan(html.indexOf(">Alpha<"));
		expect(html).not.toContain("sidebar-chat-project");
	});

	it("lists every chat newest first with its project in Recent mode", () => {
		const html = render("recent");
		expect(html).toContain('aria-label="Sort chats: Recent"');
		expect(html.indexOf("Newest chat")).toBeLessThan(
			html.indexOf("Older chat"),
		);
		// The project shows as a colour dot in the row's icon column, its name
		// in the row's tooltip.
		expect(html).toMatch(
			/sidebar-chat-lead" aria-hidden="true"><span class="sidebar-project-dot" style="background:#[0-9a-f]{6}"/,
		);
		expect(html).toContain('title="Newest chat · Beta"');
		expect(html).not.toContain("sidebar-chat-project");
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
			<RenderAsHydrated value>
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
				/>
			</RenderAsHydrated>,
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

	it("shows one status per row on the right, in words for screen readers", () => {
		(globalThis as { window?: unknown }).window = {
			localStorage: {
				getItem: (key: string) =>
					key === CHAT_SEEN_SINCE_STORAGE_KEY ? "1" : null,
				setItem: () => undefined,
			},
		};
		const pr = (
			number: number,
			state: "open" | "draft" | "merged" | "closed",
			checks: "passed" | "failed" | null = null,
		) => ({
			number,
			url: `https://github.com/acme/alpha/pull/${number}`,
			state,
			checks,
			failedChecks: checks === "failed" ? 1 : 0,
		});
		const at = "2026-10-20T00:00:00Z";
		const chats: SidebarChat[] = [
			{
				id: "q",
				title: "Asks",
				updatedAt: at,
				turnStatus: "completed",
				waitingOn: "question",
			},
			{
				id: "w",
				title: "Busy",
				updatedAt: at,
				turnStatus: "running",
				pr: pr(1, "open"),
			},
			{
				id: "h",
				title: "Helper busy",
				updatedAt: at,
				turnStatus: "completed",
				workingSince: at,
			},
			{
				id: "f",
				title: "Broke",
				updatedAt: at,
				turnStatus: "failed",
				waitingOn: "failed",
			},
			{
				id: "p",
				title: "Passing",
				updatedAt: at,
				pr: pr(42, "open", "passed"),
			},
			{
				id: "x",
				title: "Failing",
				updatedAt: at,
				pr: pr(41, "open", "failed"),
			},
			{ id: "d", title: "Drafted", updatedAt: at, pr: pr(44, "draft") },
			{ id: "m", title: "Merged", updatedAt: at, pr: pr(39, "merged") },
			{ id: "c", title: "Closed", updatedAt: at, pr: pr(40, "closed") },
			{ id: "u", title: "Unread", updatedAt: at, turnStatus: "completed" },
			{ id: "o", title: "Old", updatedAt: at },
		];
		const html = renderToStaticMarkup(
			<RenderAsHydrated value>
				<ProjectSidebar
					projects={[alpha]}
					projectsLoading={false}
					selectedProjectId="alpha"
					onSelectProject={() => undefined}
					expanded
					onToggle={() => undefined}
					onAddProject={() => undefined}
					chats={chats}
					onNewChat={() => undefined}
				/>
			</RenderAsHydrated>,
		);
		const row = (title: string) => {
			const start = html.lastIndexOf("<li", html.indexOf(`>${title}<`));
			return html.slice(start, html.indexOf("</li>", start));
		};
		expect(row("Asks")).toContain('aria-label="Asking you a question"');
		expect(row("Asks")).toContain("lucide-message-circle-question");
		// Working beats the PR: no PR icon, a still title, and the spinner in
		// the time's place (the tooltip carries the working time).
		expect(row("Busy")).toContain('data-status="working"');
		expect(row("Busy")).not.toContain("sidebar-chat-pr");
		expect(row("Busy")).not.toContain("sidebar-chat-age");
		expect(row("Busy")).toContain(
			'<span class="sidebar-chat-title">Busy</span>',
		);
		expect(row("Busy")).toContain("sidebar-chat-working");
		expect(row("Busy")).toContain("t-matrix");
		expect(row("Busy")).not.toContain("sidebar-title-shimmer");
		expect(row("Helper busy")).toContain('data-status="working"');
		expect(row("Helper busy")).toContain("sidebar-chat-working");
		expect(row("Broke")).toContain('aria-label="Last turn failed"');
		expect(row("Broke")).toContain("lucide-triangle-alert");
		expect(row("Passing")).toContain(
			'aria-label="PR #42 open · checks passed"',
		);
		expect(row("Passing")).toContain('data-checks="passed"');
		expect(row("Passing")).toContain(">42<");
		expect(row("Failing")).toContain(
			'aria-label="PR #41 open · 1 check failed"',
		);
		expect(row("Failing")).toContain('data-checks="failed"');
		expect(row("Drafted")).toContain('aria-label="Draft PR #44"');
		expect(row("Drafted")).toContain('data-pr="draft"');
		expect(row("Merged")).toContain('aria-label="PR #39 merged"');
		expect(row("Merged")).toContain('data-pr="merged"');
		expect(row("Closed")).toContain('aria-label="PR #40 closed"');
		expect(row("Closed")).toContain('data-pr="closed"');
		expect(row("Unread")).toContain('class="sidebar-chat-unread"');
		expect(row("Unread")).toContain('aria-label="New reply"');
		expect(row("Old")).toContain('data-status="idle"');
		expect(row("Old")).toContain("sidebar-chat-age");
	});

	it("renders the server's markup while hydrating, whatever this browser saved", () => {
		const html = render("recent", false);
		// Both sort views; <html data-sidebar-sort> shows one (first-paint.ts).
		expect(html).toContain(
			'class="sidebar-recent sidebar-status-groups" data-sort-view="recent"',
		);
		expect(html).toContain(
			'class="sidebar-projects" data-sort-view="projects"',
		);
		expect(html).toContain('aria-label="Sort chats: Projects"');
		// Rows carry the ids the first-paint stylesheet targets.
		expect(html).toContain('class="sidebar-chat-row" data-chat-id="a1"');
		expect(html).toContain('class="sidebar-project" data-project-id="alpha"');
	});

	it("renders every Done row while hydrating, past the fold hidden, and marks what the rows script needs", () => {
		const done = Array.from({ length: 10 }, (_, index) => ({
			id: `d${index}`,
			title: `Done chat ${index}`,
			turnStatus: "completed" as const,
			updatedAt: `2026-10-${String(10 + index).padStart(2, "0")}T00:00:00Z`,
		}));
		const markup = (hydrated: boolean) => {
			(globalThis as { window?: unknown }).window = {
				localStorage: {
					getItem: (key: string) =>
						key === SIDEBAR_SORT_KEY ? "recent" : null,
					setItem: () => undefined,
				},
			};
			return renderToStaticMarkup(
				<QueryClientProvider client={new QueryClient()}>
					<RenderAsHydrated value={hydrated}>
						<ProjectSidebar
							projects={[alpha]}
							projectsLoading={false}
							selectedProjectId="alpha"
							onSelectProject={() => undefined}
							expanded
							onToggle={() => undefined}
							onAddProject={() => undefined}
							chats={done}
							onNewChat={() => undefined}
							projectChats={[{ project: alpha, chats: done }]}
							onOpenSettings={() => undefined}
							account={{ name: "Ada Lovelace" }}
						/>
					</RenderAsHydrated>
				</QueryClientProvider>,
			);
		};
		const recent = (html: string) =>
			html.slice(
				html.indexOf("sidebar-recent"),
				html.indexOf("sidebar-projects"),
			);
		const serverHtml = markup(false);
		expect(recent(serverHtml).match(/class="sidebar-chat-row"/g)).toHaveLength(
			10,
		);
		expect(recent(serverHtml).match(/data-done-overflow="true"/g)).toHaveLength(
			2,
		);
		expect(serverHtml).toContain("Show 2 more");
		expect(serverHtml).toContain(
			'data-seen-key="d9:completed:2026-10-19T00:00:00Z" data-updated-at="2026-10-19T00:00:00Z" data-unread-mark="true" data-attention="completed"',
		);
		expect(serverHtml).toContain("<script>");
		// The account button renders from the page's user, not after its read.
		expect(serverHtml).toContain('class="sidebar-account-name">Ada Lovelace<');
		const hydratedHtml = markup(true);
		expect(hydratedHtml.match(/class="sidebar-chat-row"/g)).toHaveLength(8);
		expect(hydratedHtml).not.toContain("data-seen-key");
		expect(hydratedHtml).not.toContain("<script>");
	});

	it("renders only the saved sort view once hydrated", () => {
		const html = render("recent");
		expect(html).not.toContain("data-sort-view");
		expect(html).not.toContain("sidebar-projects");
	});
});
