import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "#/domain/projects";
import {
	CHAT_SEEN_SINCE_STORAGE_KEY,
	SIDEBAR_COLLAPSED_PROJECTS_KEY,
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

function render(
	hydrated = true,
	extra: Partial<ComponentProps<typeof ProjectSidebar>> = {},
) {
	(globalThis as { window?: unknown }).window = {
		localStorage: { getItem: () => null, setItem: () => undefined },
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
				{...extra}
			/>
		</RenderAsHydrated>,
	);
}

afterEach(() => {
	delete (globalThis as { window?: unknown }).window;
});

describe("left sidebar: Issues and Pull requests", () => {
	const open = () => undefined;
	it("lists Issues and Pull requests above Memory", () => {
		const html = render(true, { onOpenWorkItems: open });
		const issues = html.indexOf(">Issues");
		const pulls = html.indexOf(">Pull requests");
		const memory = html.indexOf(">Memory</button>");
		expect(issues).toBeGreaterThan(-1);
		expect(issues).toBeLessThan(pulls);
		expect(pulls).toBeLessThan(memory);
	});
	it("shows no badge until something waits on the user", () => {
		const html = render(true, {
			onOpenWorkItems: open,
			waitingOnYou: { pullRequests: 0, issues: 0 },
		});
		expect(html).not.toContain("sidebar-nav-badge");
	});
	it("badges only what waits on the user, and marks the open page", () => {
		const html = render(true, {
			onOpenWorkItems: open,
			workItemsActive: "pull-requests",
			waitingOnYou: { pullRequests: 3, issues: 0 },
		});
		expect(html.match(/sidebar-nav-badge/g)).toHaveLength(1);
		expect(html).toContain('aria-label="3 waiting on you"');
		expect(html).toMatch(
			/aria-current="page"[^>]*>(?:<svg[^>]*>.*?<\/svg>)Pull requests/s,
		);
	});
	it("is absent where the page cannot open", () => {
		const html = render();
		expect(html).not.toContain("Pull requests");
		expect(html).not.toContain(">Issues");
	});
});

describe("left sidebar", () => {
	it("has a Memory entry in the sidebar", () => {
		const html = render();
		expect(html).toMatch(/class="sidebar-nav-item" aria-current="page"/);
		expect(html).toContain(">Memory</button>");
		expect(html.match(/class="sidebar-nav-item"/g)).toHaveLength(1);
		expect(html).not.toContain("Memory graph");
	});

	it("has a top-left toggle for the closed sidebar, one in its header for the open one, and no rail", () => {
		const html = render();
		expect(html).toContain("left-sidebar-toggle");
		// The open sidebar's toggle sits in its header, after the logo.
		const header = html.slice(html.indexOf('class="sidebar-brand-row"'));
		expect(header.indexOf("wordmark")).toBeLessThan(
			header.indexOf("sidebar-brand-toggle"),
		);
		expect(header.indexOf("sidebar-brand-toggle")).toBeLessThan(
			header.indexOf('class="sidebar-toolbar"'),
		);
		expect(html).not.toContain("sidebar-rail");
		expect(html.match(/class="wordmark"/g)).toHaveLength(1);
	});

	it("renders each project as its own section, the most recently active first, with no Chats header or sort", () => {
		const html = render();
		expect(html).not.toContain("sidebar-list-header");
		expect(html).not.toContain(">Chats<");
		expect(html).not.toContain("Sort chats");
		expect(html).not.toContain("sidebar-folder");
		expect(html).not.toContain("sidebar-projects");
		expect(html).not.toContain("data-sort-view");
		expect(html.match(/data-section="project"/g)).toHaveLength(2);
		expect(html.indexOf(">Beta<")).toBeLessThan(html.indexOf(">Alpha<"));
		// The same section look as Threads: the shared header and its heading.
		expect(html).toContain(
			'<h3 class="sidebar-section-title" id="sidebar-section-project-beta">',
		);
		expect(html).toContain('aria-labelledby="sidebar-section-project-beta"');
		expect(html).toContain('class="sidebar-y-section sidebar-plain-section"');
		expect(html).not.toContain('class="sidebar-section"');
	});

	it("lists a plain project's chats as flat thread rows with an id, a hover card and the project dot", () => {
		const html = render();
		const beta = html.slice(
			html.indexOf('data-project-id="beta"'),
			html.indexOf("</section>", html.indexOf('data-project-id="beta"')),
		);
		expect(beta).toContain('data-variant="thread"');
		expect(beta).toContain(">Newest chat<");
		expect(beta).toContain('class="thread-id" data-in="sidebar"');
		expect(beta).toContain("sidebar-chat-meta-project");
		expect(beta).toContain("sidebar-project-dot");
		// ThreadHoverCard's trigger wraps the row.
		expect(beta).toContain('data-state="closed"');
		expect(beta).not.toContain("Older chat");
	});

	it("gives every thread row a Y in its own colour, and the super agent keeps its own mark", () => {
		const numbered = [
			{
				id: "c1",
				title: "First",
				updatedAt: "2026-10-19T00:00:00Z",
				threadNumber: 1,
			},
			{
				id: "c2",
				title: "Second",
				updatedAt: "2026-10-18T00:00:00Z",
				threadNumber: 2,
			},
		];
		const html = render(true, {
			projectChats: [{ project: beta, chats: numbered }],
		});
		const row = (id: string) => {
			const start = html.indexOf(`data-chat-id="${id}"`);
			return html.slice(start, html.indexOf("</li>", start));
		};
		// The agent colours, in order: thread 1 the first, thread 2 the second.
		expect(row("c1")).toContain("--thread-color:#83C1FF");
		expect(row("c2")).toContain("--thread-color:#9CD242");
		expect(row("c1")).toContain('class="thread-mark"');
		expect(row("c1")).toContain('class="sidebar-chat-lead"');
		// No second "2": that is the super agent's.
		expect(row("c1")).not.toContain("y2-mark");
	});

	it("draws one thread Y for every thread row, and none for the super agent's row", () => {
		const html = render();
		const threadRows = html.match(/data-variant="thread"/g)?.length ?? 0;
		expect(threadRows).toBeGreaterThan(0);
		expect(html.match(/class="thread-mark"/g)).toHaveLength(threadRows);
	});

	it("names a numbered thread once: the dot and ytimesy-12, not the project twice", () => {
		const numbered = [
			{
				id: "b1",
				title: "Newest chat",
				updatedAt: "2026-10-19T00:00:00Z",
				threadNumber: 12,
			},
		];
		const html = render(true, {
			projectChats: [{ project: beta, chats: numbered }],
		});
		const row = html.slice(html.indexOf('data-chat-id="b1"'));
		const meta = row.slice(0, row.indexOf("</li>"));
		expect(meta).toContain('class="thread-id" data-in="sidebar"');
		expect(meta).toContain("beta-12");
		expect(meta).not.toContain("<span>Beta</span>");
	});

	it("has a + on each plain project's own header, labelled with that project (never on the Threads header)", () => {
		// No DOM here: the + is inside its own project's section, named for
		// it; its handler is onNewChat(project.id) (project-sidebar.tsx).
		const html = render();
		const section = (id: string) => {
			const start = html.indexOf(`data-project-id="${id}"`);
			return html.slice(start, html.indexOf("</section>", start));
		};
		expect(section("beta")).toContain('aria-label="New chat in Beta"');
		expect(section("beta")).not.toContain('aria-label="New chat in Alpha"');
		expect(section("alpha")).toContain('aria-label="New chat in Alpha"');
		expect(html.match(/class="sidebar-section-add"/g)).toHaveLength(2);
	});

	it("keeps the archive action, the fold and the project name on each plain header", () => {
		const html = render(true, { onDeleteProject: () => undefined });
		expect(html).toContain('aria-label="Archive Beta"');
		expect(html).toContain('title="Archive project"');
		expect(html).toContain('aria-label="Collapse Beta"');
		expect(html).toContain('aria-controls="sidebar-project-body-beta"');
		expect(html).toContain('id="sidebar-project-body-beta"');
		// The name opens the project; the open one is the current page.
		expect(html).toMatch(
			/class="sidebar-project-name" aria-current="page">.*?Alpha/s,
		);
		expect(render()).not.toContain("Archive Beta");
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
			localStorage: { getItem: () => null, setItem: () => undefined },
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
		const needs = html.indexOf(">Asks a question<");
		const working = html.indexOf(">Busy chat<");
		const done = html.indexOf(">Done chat");
		expect(needs).toBeGreaterThan(-1);
		expect(needs).toBeLessThan(working);
		expect(working).toBeLessThan(done);
		expect(html).toContain('data-activity="needs-you"');
		expect(html).toContain('data-activity="running"');
		// Five finished chats show; the other five fold into Settled.
		expect(html).toContain(
			'<span>Settled</span><span class="sidebar-status-count">5</span>',
		);
		expect(html.match(/data-group="done"/g)).toHaveLength(5);
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
		// A section shows five finished chats and folds the rest into Settled,
		// so the rows are rendered in two sections' worth.
		const markup = (list: SidebarChat[]) =>
			renderToStaticMarkup(
				<RenderAsHydrated value>
					<ProjectSidebar
						projects={[alpha]}
						projectsLoading={false}
						selectedProjectId="alpha"
						onSelectProject={() => undefined}
						expanded
						onToggle={() => undefined}
						onAddProject={() => undefined}
						chats={list}
						onNewChat={() => undefined}
					/>
				</RenderAsHydrated>,
			);
		const html = markup(chats.slice(0, 9)) + markup(chats.slice(9));
		const row = (title: string) => {
			const start = html.lastIndexOf("<li", html.indexOf(`>${title}<`));
			return html.slice(start, html.indexOf("</li>", start));
		};
		expect(row("Asks")).toContain('aria-label="Asking you a question"');
		// A thread row shows a waiting chat as a dot, not an icon.
		expect(row("Asks")).toContain("sidebar-chat-needs-you");
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
		expect(row("Passing")).toContain("#42");
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
		const html = render(false);
		expect(html).not.toContain("data-sort-view");
		// Every section renders open; the first-paint script folds the saved ones.
		expect(html).toContain('data-project-id="alpha"');
		expect(html).toContain('data-open="true"');
		// Rows carry the ids the first-paint stylesheet targets.
		expect(html).toMatch(/class="sidebar-chat-row"[^>]*data-chat-id="a1"/);
		// A saved fold or pin only shows once hydrated.
		(globalThis as { window?: unknown }).window = {
			localStorage: {
				getItem: (key: string) =>
					key === SIDEBAR_COLLAPSED_PROJECTS_KEY
						? JSON.stringify(["beta"])
						: null,
				setItem: () => undefined,
			},
		};
		const folded = renderToStaticMarkup(
			<RenderAsHydrated value>
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
				/>
			</RenderAsHydrated>,
		);
		expect(folded).toContain('aria-label="Expand Beta"');
		expect(folded).not.toContain("Newest chat");
		expect(folded).toContain("Older chat");
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
				localStorage: { getItem: () => null, setItem: () => undefined },
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
		const section = (html: string) =>
			html.slice(
				html.indexOf('data-section="project"'),
				html.indexOf("</section>"),
			);
		const serverHtml = markup(false);
		// Every finished chat renders: five visible, five past the fold hidden.
		expect(section(serverHtml).match(/data-group="done"/g)).toHaveLength(10);
		expect(
			section(serverHtml).match(/data-done-overflow="true"/g),
		).toHaveLength(5);
		expect(serverHtml).toContain(
			'data-seen-key="d9:completed:2026-10-19T00:00:00Z" data-updated-at="2026-10-19T00:00:00Z" data-unread-mark="true"',
		);
		expect(serverHtml).toContain("<script>");
		// The account button renders from the page's user, not after its read.
		expect(serverHtml).toContain('class="sidebar-account-name">Ada Lovelace<');
		const hydratedHtml = markup(true);
		expect(hydratedHtml.match(/data-group="done"/g)).toHaveLength(5);
		expect(hydratedHtml).not.toContain("data-done-overflow");
		expect(hydratedHtml).not.toContain("data-seen-key");
		expect(hydratedHtml).not.toContain("<script>");
	});

	it("lists a project without Y as its own section, with no Y² or Threads", () => {
		const html = render();
		expect(html).not.toContain("sidebar-y2");
		expect(html).not.toContain('data-section="threads"');
		expect(html).toContain('data-section="project"');
	});
});

describe("Y projects: the Y² and Threads sections", () => {
	const at = "2026-10-20T00:00:00Z";
	const pr = {
		number: 105,
		url: "https://github.com/acme/alpha/pull/105",
		state: "open" as const,
		checks: "passed" as const,
		failedChecks: 0,
	};
	const finished = Array.from({ length: 10 }, (_, index) => ({
		id: `t${index}`,
		title: `Thread ${index}`,
		updatedAt: `2026-10-${String(10 + index).padStart(2, "0")}T00:00:00Z`,
		turnStatus: "completed" as const,
	}));
	const alphaChats: SidebarChat[] = [
		{ id: "y2", title: "Y²", role: "y2", updatedAt: at },
		{ id: "busy", title: "Busy", updatedAt: at, turnStatus: "running" },
		{ id: "asks", title: "Asks", updatedAt: at, waitingOn: "question" },
		{ id: "secret", title: "Needs a key", updatedAt: at, waitingOn: "secret" },
		{
			id: "shipped",
			title: "Shipped",
			updatedAt: at,
			turnStatus: "completed",
			pr,
			listedModelId: "gpt-5",
			workspaceId: "ws-1",
		},
		...finished,
	];
	const betaChats: SidebarChat[] = [
		{ id: "b1", title: "Plain chat", updatedAt: "2026-10-19T00:00:00Z" },
	];
	const view = (
		hydrated = true,
		extra: Partial<ComponentProps<typeof ProjectSidebar>> = {},
	) =>
		render(hydrated, {
			chats: alphaChats,
			projectChats: [
				{ project: alpha, chats: alphaChats },
				{ project: beta, chats: betaChats },
			],
			...extra,
		});
	const sections = (html: string) => {
		const y2 = html.indexOf('data-section="y2"');
		const threads = html.indexOf('data-section="threads"');
		return {
			y2: html.slice(y2, threads),
			threads: html.slice(threads, html.indexOf("</section>", threads)),
		};
	};
	describe("Y sections", () => {
		it('labels the section "Super agent" once (the mark is already there), never a second label in the row', () => {
			const html = view();
			expect(html.match(/Super agent/g)).toHaveLength(1);
			expect(html).not.toContain("Y²");
			expect(html).toContain(
				'<h3 class="sidebar-section-title" id="sidebar-section-y2">Super agent</h3>',
			);
			expect(html).toContain('aria-labelledby="sidebar-section-y2"');
			expect(html).toContain('aria-labelledby="sidebar-section-threads"');
		});

		it("lists one row per Y project: the mark, the project's name, its age and a thread summary", () => {
			const { y2 } = sections(view());
			expect(y2.match(/data-role="y2"/g)).toHaveLength(1);
			expect(y2).toContain('class="y2-mark"');
			expect(y2).toContain('data-live="true"');
			expect(y2).toContain('<span class="sidebar-chat-title">Alpha</span>');
			expect(y2).toContain(
				'<span class="sidebar-chat-meta">1 working · 2 needs you</span>',
			);
			// A Y² that needs the person shows the needs-you icon, in the age's place.
			expect(y2).toContain('data-status="asking"');
			expect(y2).toContain('aria-label="2 threads need you"');
			// Not the plain project, nor any thread.
			expect(y2).not.toContain("Beta");
			expect(y2).not.toContain("Asks");
		});

		it("lists the Y threads flat: title, then a grey line with project, model, machine and PR", () => {
			const { threads } = sections(view());
			expect(threads).toContain('class="sidebar-chats sidebar-threads"');
			const row = threads.slice(threads.indexOf('data-chat-id="shipped"'));
			const shipped = row.slice(0, row.indexOf("</li>"));
			expect(shipped).toContain('data-variant="thread"');
			expect(shipped).toContain(
				'<span class="sidebar-chat-title">Shipped</span>',
			);
			expect(shipped).toContain(
				'class="sidebar-chat-meta-project"><span class="sidebar-project-dot"',
			);
			expect(shipped).toContain("<span>Alpha</span>");
			expect(shipped).toContain('data-meta="model"');
			expect(shipped).toContain('title="gpt-5"');
			expect(shipped).toContain('data-meta="machine"');
			// The PR badge sits on the second line, outside the button.
			expect(shipped).toContain('class="sidebar-chat-meta-end"');
			expect(shipped).toContain("#105");
			expect(shipped.indexOf("sidebar-chat-meta-end")).toBeGreaterThan(
				shipped.indexOf("</button>"),
			);
			// The age stays top right.
			expect(shipped).toContain('class="sidebar-chat-age"');
			// A thread without a model or workspace shows neither icon.
			const plainRow = threads.slice(threads.indexOf('data-chat-id="busy"'));
			expect(plainRow.slice(0, plainRow.indexOf("</li>"))).not.toContain(
				"data-meta=",
			);
		});

		it("orders Needs you, then Working, then Done, and folds the rest into Settled", () => {
			const { threads } = sections(view());
			const at = (title: string) => threads.indexOf(`>${title}</span>`);
			expect(at("Asks")).toBeGreaterThan(-1);
			expect(at("Needs a key")).toBeGreaterThan(at("Asks") - 1);
			expect(at("Busy")).toBeGreaterThan(at("Needs a key"));
			// Done by recency: the newest finished threads, five visible (one is the PR thread).
			expect(at("Shipped")).toBeGreaterThan(at("Busy"));
			expect(at("Thread 9")).toBeGreaterThan(at("Shipped"));
			expect(threads).toContain(">Thread 6<");
			expect(threads).not.toContain(">Thread 5<");
			expect(threads).toContain(
				'aria-expanded="false" aria-controls="sidebar-settled-list"',
			);
			expect(threads).toContain(
				'<span>Settled</span><span class="sidebar-status-count">6</span>',
			);
			expect(threads).not.toContain('id="sidebar-settled-list"');
			expect(threads).not.toContain("Show 6 more");
		});

		it("keeps the Y² and Threads sections flat: no nesting classes, guide line or in-row fold", () => {
			const html = view();
			for (const gone of [
				"sidebar-y2-branch",
				"sidebar-y2-threads",
				"sidebar-y2-label",
				"sidebar-y2-count",
				"sidebar-y2-toggle",
				'class="sidebar-y2"',
				"sidebar-section-label",
				"Collapse Y² threads",
			])
				expect(html).not.toContain(gone);
			expect(html).not.toContain("<h3>Y</h3>");
		});

		it("has no + on the Threads header (it started the chat in the Y project, not the open one)", () => {
			const html = view();
			const { threads, y2 } = sections(html);
			expect(threads).not.toContain("sidebar-section-add");
			expect(threads).not.toContain("New chat in");
			expect(y2).not.toContain("sidebar-section-add");
		});

		it("lists the plain project below them as its own modern section", () => {
			const html = view();
			expect(html).toContain('data-section="project" data-project-id="beta"');
			expect(html.match(/data-section="project"/g)).toHaveLength(1);
			expect(html.indexOf('data-section="threads"')).toBeLessThan(
				html.indexOf('data-section="project"'),
			);
			const beta = html.slice(html.indexOf('data-project-id="beta"'));
			expect(beta).toContain(">Plain chat<");
			expect(html).not.toContain(">Chats<");
		});
	});

	it("shows the Y² and Threads sections once, before the plain sections, before hydration too", () => {
		const server = view(false);
		expect(server.match(/data-section="y2"/g)).toHaveLength(1);
		expect(server.match(/data-section="threads"/g)).toHaveLength(1);
		expect(server.match(/data-section="project"/g)).toHaveLength(1);
		expect(server.indexOf('data-section="y2"')).toBeLessThan(
			server.indexOf('data-section="project"'),
		);
	});

	it("renders every Settled row hidden while hydrating, for the rows script, and none once hydrated", () => {
		const server = view(false);
		const { threads } = sections(server);
		expect(threads.match(/data-done-overflow="true"/g)).toHaveLength(6);
		expect(threads.match(/data-group="done"/g)).toHaveLength(11);
		expect(threads).toContain("data-seen-key=");
		const hydrated = sections(view(true)).threads;
		expect(hydrated).not.toContain("data-done-overflow");
		expect(hydrated.match(/data-group="done"/g)).toHaveLength(5);
	});

	it("shows the project's last activity as the age when nothing needs the person", () => {
		const calm: SidebarChat[] = [
			{ id: "y2", title: "Y²", role: "y2", updatedAt: at },
			{ id: "t1", title: "Calm", updatedAt: "2026-10-21T00:00:00Z" },
		];
		const { y2 } = sections(
			view(true, {
				chats: calm,
				projectChats: [{ project: alpha, chats: calm }],
				projects: [alpha],
			}),
		);
		expect(y2).toContain('class="sidebar-chat-age"');
		expect(y2).toContain("All idle · 1 thread");
		expect(y2).not.toContain('data-status="asking"');
		expect(y2).not.toContain('data-live="true"');
	});

	it("keeps the open thread out of Settled", () => {
		const html = view(true, { selectedChatId: "t0" });
		const { threads } = sections(html);
		expect(threads).toContain(">Thread 0<");
		expect(threads).toContain(
			'<span>Settled</span><span class="sidebar-status-count">5</span>',
		);
	});

	it("puts a pinned thread first among its status group (CSS order lifts the pin)", () => {
		(globalThis as { window?: unknown }).window = {
			localStorage: {
				getItem: (key: string) =>
					key === "ytimesy-pinned-chats" ? JSON.stringify(["t0"]) : null,
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
					chats={alphaChats}
					onNewChat={() => undefined}
					projectChats={[{ project: alpha, chats: alphaChats }]}
				/>
			</RenderAsHydrated>,
		);
		const { threads } = sections(html);
		expect(threads).toContain('data-pinned="true"');
		expect(threads).toContain('aria-label="Unpin Thread 0"');
		// The oldest finished thread, pinned, stays in view (not in Settled).
		expect(threads.indexOf(">Thread 0<")).toBeLessThan(
			threads.indexOf("sidebar-settled"),
		);
	});

	it("shows no Threads '+' when several Y projects exist and none is open", () => {
		const second: SidebarChat[] = [
			{ id: "y2b", title: "Y²", role: "y2", updatedAt: at },
			{ id: "bt", title: "Beta thread", updatedAt: at },
		];
		const html = view(true, {
			selectedProjectId: undefined,
			projectChats: [
				{ project: alpha, chats: alphaChats },
				{ project: beta, chats: second },
			],
		});
		expect(html.match(/data-role="y2"/g)).toHaveLength(2);
		expect(html).not.toContain("sidebar-section-add");
		expect(html).not.toContain("sidebar-list-header");
	});

	it("says there are no threads for a Y project that has none", () => {
		const html = view(true, {
			chats: [alphaChats[0] as SidebarChat],
			projectChats: [
				{ project: alpha, chats: [alphaChats[0] as SidebarChat] },
				{ project: beta, chats: betaChats },
			],
		});
		expect(html).toContain("No threads yet.");
		expect(html).toContain(
			'<span class="sidebar-chat-meta">No threads yet</span>',
		);
	});
});

describe("Y² and Threads (styles)", () => {
	const css = readFileSync(
		new URL("../../styles.css", import.meta.url),
		"utf8",
	);
	it("draws Y²'s Y as tall as a thread's Y at the same size", () => {
		// A thread's Y is 28 of the 32 units of its drawing; Y²'s drawing is 38
		// tall to make room for the exponent, so it is drawn 38/32 as tall.
		expect(css).toMatch(
			/\.y2-mark \{[^}]*height: calc\(var\(--y2m\) \* 38 \/ 32\);[^}]*width: calc\(var\(--y2m\) \* 40 \/ 32\);/,
		);
		expect(css).toMatch(
			/\.thread-mark \{[^}]*height: var\(--thread-mark, 16px\);/,
		);
	});

	it("drops the nested branch, guide line, indent and fold properties", () => {
		for (const gone of [
			".sidebar-y2-branch",
			".sidebar-y2-threads",
			".sidebar-y2-toggle",
			".sidebar-y2-label",
			"--y2-branch",
			"--y2-chevron",
			"--y2-toggle-shown",
			".sidebar-section-label",
		])
			expect(css).not.toContain(gone);
		expect(css).not.toMatch(/\.sidebar-y2 \{/);
	});

	it("lays a thread out flat in a grid: no indent, a second line, the PR bottom right", () => {
		expect(css).toMatch(
			/\.sidebar-chat-row\[data-variant="thread"\] \{[^}]*display: grid;/,
		);
		expect(css).toMatch(/\.sidebar-chat-meta-end \{[^}]*grid-row: 2;/);
		expect(css).toMatch(/\.sidebar-settled-list \[data-done-overflow\] \{/);
	});
});
