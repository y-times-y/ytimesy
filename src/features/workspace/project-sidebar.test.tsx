import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
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

function render(
	stored: string | null,
	hydrated = true,
	extra: Partial<ComponentProps<typeof ProjectSidebar>> = {},
) {
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
		const html = render(null, true, { onOpenWorkItems: open });
		const issues = html.indexOf(">Issues");
		const pulls = html.indexOf(">Pull requests");
		const memory = html.indexOf(">Memory</button>");
		expect(issues).toBeGreaterThan(-1);
		expect(issues).toBeLessThan(pulls);
		expect(pulls).toBeLessThan(memory);
	});
	it("shows no badge until something waits on the user", () => {
		const html = render(null, true, {
			onOpenWorkItems: open,
			waitingOnYou: { pullRequests: 0, issues: 0 },
		});
		expect(html).not.toContain("sidebar-nav-badge");
	});
	it("badges only what waits on the user, and marks the open page", () => {
		const html = render(null, true, {
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
		const html = render(null);
		expect(html).not.toContain("Pull requests");
		expect(html).not.toContain(">Issues");
	});
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
		expect(header.indexOf("wordmark")).toBeLessThan(
			header.indexOf("sidebar-brand-toggle"),
		);
		expect(header.indexOf("sidebar-brand-toggle")).toBeLessThan(
			header.indexOf('class="sidebar-toolbar"'),
		);
		expect(html).not.toContain("sidebar-rail");
		expect(html.match(/class="wordmark"/g)).toHaveLength(1);
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
			'data-seen-key="d9:completed:2026-10-19T00:00:00Z" data-updated-at="2026-10-19T00:00:00Z" data-unread-mark="true"',
		);
		expect(serverHtml).toContain("<script>");
		// The account button renders from the page's user, not after its read.
		expect(serverHtml).toContain('class="sidebar-account-name">Ada Lovelace<');
		const hydratedHtml = markup(true);
		expect(hydratedHtml.match(/class="sidebar-chat-row"/g)).toHaveLength(8);
		expect(hydratedHtml).not.toContain("data-seen-key");
		expect(hydratedHtml).not.toContain("<script>");
	});

	it("lists a project without Y as a flat list of chats", () => {
		const html = render(null);
		expect(html).not.toContain("sidebar-y2");
	});

	it("renders only the saved sort view once hydrated", () => {
		const html = render("recent");
		expect(html).not.toContain("data-sort-view");
		expect(html).not.toContain("sidebar-projects");
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
		sort: "recent" | "projects" | null,
		hydrated = true,
		extra: Partial<ComponentProps<typeof ProjectSidebar>> = {},
	) =>
		render(sort, hydrated, {
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

	for (const sort of ["recent", "projects"] as const) {
		describe(`${sort} view`, () => {
			it('labels the section "Super agent" once (the mark is already there), never a second label in the row', () => {
				const html = view(sort);
				expect(html.match(/Super agent/g)).toHaveLength(1);
				expect(html).not.toContain("Y²");
				expect(html).toContain(
					'<h3 class="sidebar-section-title" id="sidebar-section-y2">Super agent</h3>',
				);
				expect(html).toContain('aria-labelledby="sidebar-section-y2"');
				expect(html).toContain('aria-labelledby="sidebar-section-threads"');
			});

			it("lists one row per Y project: the mark, the project's name, its age and a thread summary", () => {
				const { y2 } = sections(view(sort));
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
				const { threads } = sections(view(sort));
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
				const { threads } = sections(view(sort));
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
				const html = view(sort);
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
				const html = view(sort);
				const { threads, y2 } = sections(html);
				expect(threads).not.toContain("sidebar-section-add");
				expect(threads).not.toContain("New chat in");
				expect(y2).not.toContain("sidebar-section-add");
			});

			it("leaves the plain project exactly as before", () => {
				const html = view(sort);
				if (sort === "projects") {
					expect(html).toContain(
						'class="sidebar-project" data-project-id="beta"',
					);
					expect(html).not.toContain(
						'class="sidebar-project" data-project-id="alpha"',
					);
				} else {
					expect(html).toContain(">Plain chat<");
					expect(html).toContain('data-group="done" data-section="plain"');
					expect(html).not.toContain("sidebar-projects");
				}
			});
		});
	}

	it("shows the same Y² and Threads sections once in each sort view, before hydration too", () => {
		const server = view(null, false);
		expect(server.match(/data-section="y2"/g)).toHaveLength(1);
		expect(server.match(/data-section="threads"/g)).toHaveLength(1);
		// Both plain views render; the Y sections are not repeated per view.
		expect(server).toContain('data-sort-view="recent"');
		expect(server).toContain('data-sort-view="projects"');
		const y = server.indexOf('data-section="y2"');
		expect(y).toBeLessThan(server.indexOf('data-sort-view="recent"'));
	});

	it("renders every Settled row hidden while hydrating, for the rows script, and none once hydrated", () => {
		const server = view("projects", false);
		const { threads } = sections(server);
		expect(threads.match(/data-done-overflow="true"/g)).toHaveLength(6);
		expect(threads.match(/data-group="done"/g)).toHaveLength(11);
		expect(threads).toContain("data-seen-key=");
		const hydrated = sections(view("projects", true)).threads;
		expect(hydrated).not.toContain("data-done-overflow");
		expect(hydrated.match(/data-group="done"/g)).toHaveLength(5);
	});

	it("shows the project's last activity as the age when nothing needs the person", () => {
		const calm: SidebarChat[] = [
			{ id: "y2", title: "Y²", role: "y2", updatedAt: at },
			{ id: "t1", title: "Calm", updatedAt: "2026-10-21T00:00:00Z" },
		];
		const { y2 } = sections(
			view("recent", true, {
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
		const html = view("projects", true, { selectedChatId: "t0" });
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
		const html = view("recent", true, {
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
		const html = view("projects", true, {
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
