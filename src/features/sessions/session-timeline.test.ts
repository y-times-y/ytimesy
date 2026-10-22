import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentTaskActivity } from "#/domain/child-task-activity";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import { withStoppedNotice } from "#/domain/turn-end";
import { SessionTimeline } from "./session-timeline";

// Replies render through the real Markdown renderer (the app loads it lazily).
vi.mock("./agent-markdown", async () => ({
	AgentMarkdown: (await import("./agent-markdown-renderer")).AgentMarkdown,
}));

function readCall(
	id: string,
	status: "inProgress" | "completed",
	tool = "read_file",
): SessionItem {
	return {
		kind: "dynamicToolCall",
		id: SessionItemId(id),
		tool,
		status,
	};
}

function thought(id: string, inProgress: boolean): SessionItem {
	return {
		kind: "reasoning",
		id: SessionItemId(id),
		summaries: ["Looking at the session timeline"],
		durationSeconds: inProgress ? undefined : 4,
	};
}

function renderTimeline(
	items: readonly SessionItem[],
	turnStatus: "running" | "completed",
) {
	return renderToString(createElement(SessionTimeline, { items, turnStatus }));
}

describe("session timeline live collapse", () => {
	it("renders inspectable shell inputs and results rather than a bare tool label", () => {
		const html = renderTimeline(
			[
				{
					kind: "dynamicToolCall",
					id: SessionItemId("call"),
					tool: "bash",
					status: "completed",
					input: '{"command":"pnpm test"}',
					output: "3 tests passed",
				},
			],
			"completed",
		);
		expect(html).toContain(
			'<details class="session-activity" data-kind="dynamicToolCall"',
		);
		expect(html).toContain("pnpm test");
		expect(html).toContain("3 tests passed");
	});
	it("marks a helper's start and finish in the lead's chat, not an internal handoff bubble", () => {
		const child: AgentTaskActivity = {
			id: "child",
			parentSessionId: "root",
			title: "Fix branch picker",
			label: "Task 1",
			depth: 1,
			status: "done",
			prompt: "Fix the picker",
			placement: "fresh",
			access: "read_write",
			summary: "Implemented",
			harnessId: "codex",
			listedModelId: null,
			createdAt: new Date(2000).toISOString(),
			updatedAt: new Date(3000).toISOString(),
			turnStatus: "completed",
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("child-instructions"),
					text: "Inspect the repository and implement the fix",
				},
				thought("child-thought", false),
				readCall("child-read", "completed"),
				{
					kind: "agentMessage",
					id: SessionItemId("result"),
					text: "**Verified** the fix",
				},
			],
		};
		const html = renderToString(
			createElement(SessionTimeline, {
				turnStatus: "completed",
				tasks: [child],
				helperLines: {
					identities: new Map([
						[
							"child",
							{
								name: "Fix branch picker",
								color: "var(--agent-build)",
								icon: "hammer" as const,
								tag: "Build",
							},
						],
					]),
					onSelect: () => {},
				},
				items: [
					{
						kind: "userMessage",
						id: SessionItemId("prompt"),
						text: "Fix it",
						timing: { startedAt: 1000 },
					},
					{
						kind: "userMessage",
						id: SessionItemId("notice"),
						text: "Fix branch picker finished. Its final summary is below:\n\nImplemented\n\nInspect its evidence and diff before accepting or publishing the result.",
					},
				],
			}),
		);
		// The lead's chat shows a start line and a finish line, not the helper's transcript.
		expect(html).toContain("Started “Fix branch picker”");
		expect(html).toContain(
			'<span class="helper-line-text" title="Implemented">“Fix branch picker” finished</span>',
		);
		expect(html).not.toContain("child-task-card");
		expect(html).not.toContain("Looking at the session timeline");
		expect(html).not.toContain("Its final summary is below");
		expect(html).not.toContain("Inspect its evidence and diff");
		const waiting = renderToString(
			createElement(SessionTimeline, {
				turnStatus: "completed",
				items: [],
				tasks: [{ ...child, turnStatus: "running", status: "working" }],
			}),
		);
		expect(waiting).toContain("Waiting for subagents");
		expect(waiting).not.toContain(">Thinking<");
	});
	it("shows a helper's own conversation with senders and steering still queued", () => {
		const html = renderToString(
			createElement(SessionTimeline, {
				turnStatus: "running",
				senderName: "Main",
				queuedSteering: [{ id: "q", from: "Main", text: "Use the v2 API" }],
				items: [
					{
						kind: "userMessage",
						id: SessionItemId("brief"),
						text: "Fix the export",
					},
					{
						kind: "userMessage",
						id: SessionItemId("steer:job"),
						text: "Message from the user, sent directly from the chat:\n\nSkip the docs\n\nCoordination message ID: job\n\nThis is the user steering you directly.",
					},
				],
			}),
		);
		expect(html).toContain('<span class="session-message-sender">Main</span>');
		expect(html).toContain('<span class="session-message-sender">You</span>');
		expect(html).toContain("<p>Skip the docs</p>");
		expect(html).not.toContain("Coordination message ID");
		expect(html).toContain("Queued</span>");
		expect(html).toContain("Use the v2 API");
	});
	it("shows a persisted failure reason in the chat", () => {
		const html = renderTimeline(
			[
				{
					kind: "error",
					id: SessionItemId("turn-error"),
					message:
						"The provider rate limit was reached (HTTP 429). Wait and retry. No fallback was used.",
				},
			],
			"completed",
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain("provider rate limit was reached");
	});

	it("folds commentary and tools only after completion and keeps the final answer outside", () => {
		const items: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("u"),
				text: "Check it",
				timing: { startedAt: 1000, completedAt: 73000 },
			},
			{
				kind: "agentMessage",
				id: SessionItemId("update"),
				text: "Checking the files",
			},
			thought("reasoning", false),
			readCall("read", "completed"),
			{
				kind: "agentMessage",
				id: SessionItemId("final"),
				text: "Here is the result",
			},
		];
		expect(renderTimeline(items, "running")).not.toContain(
			'class="session-work"',
		);
		const done = renderTimeline(items, "completed");
		expect(done.match(/class="session-work"/g)).toHaveLength(1);
		expect(done).toContain("Worked for 1m 12s");
		expect(done).not.toContain("steps");
		const workEnd = done.indexOf("</div></details></li>");
		expect(done.indexOf("Checking the files")).toBeLessThan(workEnd);
		expect(done.indexOf("Here is the result")).toBeGreaterThan(workEnd);
	});

	it("omits empty completed reasoning", () => {
		const html = renderTimeline(
			[{ kind: "reasoning", id: SessionItemId("empty"), summaries: [] }],
			"completed",
		);
		expect(html).not.toContain("Thought");
		expect(html).not.toContain('class="session-work"');
	});
	it("does not reactivate historical reasoning, tools, or streaming on a new prompt", () => {
		const html = renderTimeline(
			[
				thought("old-thought", true),
				readCall("old-read", "inProgress"),
				{
					kind: "agentMessage",
					id: SessionItemId("old-answer"),
					text: "Previous answer",
					streaming: true,
				},
				{
					kind: "userMessage",
					id: SessionItemId("new-prompt"),
					text: "Next question",
				},
				thought("new-thought", true),
			],
			"running",
		);
		const historical = html.split('data-kind="userMessage"')[0];
		expect(historical).not.toContain('data-live="true"');
		expect(historical).not.toContain('data-streaming="true"');
		expect(historical).not.toMatch(/<details[^>]*open/);
		expect(html.split('data-kind="userMessage"')[1]).toMatch(
			/data-kind="reasoning"[^>]*open/,
		);
	});

	it("renders file icons before any diff exists", () => {
		const html = renderTimeline(
			[
				{
					kind: "agentMessage",
					id: SessionItemId("reference"),
					text: "Read `src/styles.css`.",
				},
			],
			"completed",
		);
		expect(html).toContain("file-type-icon");
		expect(html).not.toContain("data-change=");
	});
	it("opens Explored while a read is in progress so tools stream inside the group", () => {
		const html = renderTimeline(
			[
				readCall("read-1", "completed"),
				readCall("read-2", "inProgress", "read session-timeline.tsx"),
			],
			"running",
		);
		expect(html).toContain("session-exploration");
		expect(html).toContain("data-live");
		expect(html).toContain("Explored 2 files");
		expect(html).toMatch(/<details[^>]*open/);
		expect(html).toContain("read session-timeline.tsx");
	});

	it("keeps a finished Explored group collapsed so it can be uncollapsed later", () => {
		const html = renderTimeline(
			[readCall("read-1", "completed"), readCall("read-2", "completed")],
			"completed",
		);
		expect(html).toContain("Explored 2 files");
		expect(html).not.toMatch(
			/<details[^>]*class="session-exploration"[^>]*open/,
		);
		expect(html).not.toMatch(/session-exploration"[^>]*data-live/);
	});

	it("opens thinking with summaries while live and collapses when the thought finishes", () => {
		const live = renderTimeline([thought("r1", true)], "running");
		expect(live).toMatch(/data-kind="reasoning"[^>]*open/);
		expect(live).toContain("Looking at the session timeline");

		const done = renderTimeline([thought("r1", false)], "completed");
		expect(done).not.toMatch(/data-kind="reasoning"[^>]*open/);
		expect(done).toContain("Looking at the session timeline");
	});

	it("renders mentioned files as clickable text with a file icon", () => {
		const html = renderToString(
			createElement(SessionTimeline, {
				items: [
					{
						kind: "agentMessage",
						id: SessionItemId("msg-1"),
						text: "Updated `src/styles.css`.",
					},
					{
						kind: "fileChange",
						id: SessionItemId("file-1"),
						status: "completed",
						changes: [
							{
								path: "src/styles.css",
								change: "update",
								additions: 2,
								deletions: 1,
								preview: "+ok\n",
							},
						],
					},
				],
				turnStatus: "completed",
				onOpenFile: () => undefined,
			}),
		);
		expect(html).toContain("session-file-open");
		expect(html).toContain("file-type-icon");
		expect(html).toContain('data-change="update"');
		const response = html.split('<li data-kind="fileChange">')[0];
		expect(response).not.toContain("data-change=");
		expect(response).toContain("file-type-icon");
		expect(response).toContain('title="Open src/styles.css"');
		expect(html).toContain("src/styles.css");
	});
});

function render(
	items: SessionItem[],
	turnStatus: SessionTurnStatus,
	tasks: AgentTaskActivity[] = [],
) {
	return renderToString(
		createElement(SessionTimeline, { items, turnStatus, tasks }),
	);
}

const user = (id: string, text = id): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text,
});
const answer = (id: string, text: string): SessionItem => ({
	kind: "agentMessage",
	id: SessionItemId(id),
	text,
});
const spawn: SessionItem = {
	kind: "dynamicToolCall",
	id: SessionItemId("spawn"),
	tool: "agent",
	input: JSON.stringify({ role: "writer", title: "Fix the parser" }),
	status: "completed",
};

/** The <details> "Worked" groups' inner HTML, and what shows outside them. */
function split(html: string) {
	const worked = [
		...html.matchAll(/<details class="session-work">.*?<\/details>/g),
	]
		.map((match) => match[0])
		.join("");
	return { worked, outside: html.replace(/<details.*?<\/details>/g, "") };
}

describe("session timeline after a reload", () => {
	it("keeps Main's answer outside Worked when a wake-up turn followed it", () => {
		const html = render(
			[
				user("ask", "Add tests"),
				spawn,
				answer("a1", "This repo uses Vitest; a helper is writing the tests."),
				user("e1", "⁣ytimesy-child-event:e1"),
				{
					kind: "dynamicToolCall",
					id: SessionItemId("check"),
					tool: "bash",
					status: "completed",
				},
				answer("a2", "The helper added 4 tests and they pass."),
			],
			"completed",
		);
		const { outside } = split(html);
		expect(outside).toContain("This repo uses Vitest");
		expect(outside).toContain("The helper added 4 tests");
		expect(html).not.toContain("ytimesy-child-event");
	});

	it("shows a helper's finish as its name and finished, never the report header", () => {
		const task = {
			id: "h1",
			parentSessionId: "root",
			title: "Fix the parser",
			label: "Task 1",
			depth: 1,
			status: "done",
			prompt: "",
			placement: "fresh",
			access: "read_write",
			summary:
				"[agent 3 writer finished · Fix the parser · 12 steps · 6m · 362k tokens]\n\nParser fixed.",
			harnessId: "api",
			listedModelId: null,
			createdAt: new Date(1_000).toISOString(),
			updatedAt: new Date(2_000).toISOString(),
			items: [],
			turnStatus: "completed",
		} as AgentTaskActivity;
		const html = render(
			[user("ask"), spawn, answer("a1", "Started a helper.")],
			"completed",
			[task],
		);
		expect(html).toContain("finished</span>");
		expect(html).not.toContain("[agent 3");
		expect(html).toContain("Parser fixed. · 12 steps · 6m · 362k tokens");
	});

	it("marks a stopped turn with a muted Stopped line", () => {
		const html = render(
			withStoppedNotice(
				[
					user("ask"),
					{
						kind: "dynamicToolCall",
						id: SessionItemId("run"),
						tool: "bash",
						status: "completed",
					},
				],
				"t1",
			),
			"idle",
		);
		expect(html).toContain('class="session-stopped"');
		expect(split(html).outside).toContain(">Stopped</p>");
	});

	it("shows a question card's answer once, in the card", () => {
		const html = render(
			[
				user("ask"),
				{
					kind: "userQuestion",
					id: SessionItemId("q"),
					questions: [
						{
							question: "Which database?",
							options: [{ label: "Postgres" }, { label: "SQLite" }],
						},
					],
				},
				user("reply", "Database: Postgres"),
				answer("a", "Using Postgres."),
			],
			"completed",
		);
		expect(html.match(/Database: Postgres/g)).toHaveLength(1);
		expect(html).toContain("user-question-reply");
	});
});
