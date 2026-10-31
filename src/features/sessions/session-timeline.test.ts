import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyPlanUpdate } from "#/domain/agent-todos";
import { withBackgroundCommandExits } from "#/domain/background-command";
import {
	type AgentTaskActivity,
	childTaskEventQueueText,
	childTaskPublicItems,
} from "#/domain/child-task-activity";
import { SessionItemId } from "#/domain/ids";
import {
	type SessionItem,
	type SessionTurnStatus,
	sessionItemsFromUnknown,
	sessionItemsQueuedWithUser,
} from "#/domain/session-item";
import { settledTurnItems, withStoppedNotice } from "#/domain/turn-end";
import { RenderFoldedBodies } from "./lazy-details";
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
	return renderToString(
		createElement(
			RenderFoldedBodies.Provider,
			{ value: true },
			createElement(SessionTimeline, { items, turnStatus }),
		),
	);
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
								name: "build-1",
								task: "Fix branch picker",
								color: "#FF8F96",
								icon: "hammer" as const,
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
		// Its short name on both, the task beside it, the colour on the icon only.
		expect(html).toContain(
			'<span class="helper-line-name">build-1</span><span class="helper-line-text" title="Fix branch picker">started · <!-- -->Fix branch picker</span>',
		);
		expect(html).toContain('style="color:#FF8F96"');
		// The finish is an outlined card that opens the helper; its report's
		// first line under it, the full report on hover.
		expect(html).toMatch(
			/<button type="button" class="helper-card" data-status="finished" title="Implemented">/,
		);
		expect(html).toContain('<span class="helper-card-name">build-1</span>');
		expect(html).toContain(
			'<span class="helper-card-verb" data-verb="finished">finished</span> · Fix branch picker',
		);
		expect(html).toContain('<span class="helper-card-time">1s</span>');
		expect(html).toContain('<span class="helper-card-line">Implemented</span>');
		expect(html).not.toContain("agent-row-tag");
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
		expect(waiting).toContain("Waiting for helpers");
		expect(waiting).not.toContain(">Thinking<");
	});
	it("shows Edit and Send on a message queued in this chat", () => {
		const html = renderToString(
			createElement(SessionTimeline, {
				turnStatus: "running",
				items: [
					{
						kind: "userMessage",
						id: SessionItemId("queued-follow-up"),
						text: "Also update the README",
						queued: true,
					},
				],
				onEditQueued: () => undefined,
				onSendQueued: () => undefined,
			}),
		);
		expect(html).toContain("Also update the README");
		expect(html).toContain("Queued in this chat");
		expect(html).toContain("Edit");
		expect(html).toContain("Send");
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
		const response = html.split('data-kind="fileChange"')[0];
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

/** The "Worked" groups' HTML (nested <details> included), and what shows outside them. */
function split(html: string) {
	let worked = "";
	let outside = "";
	let at = 0;
	for (;;) {
		const start = html.indexOf('<details class="session-work">', at);
		if (start < 0) break;
		outside += html.slice(at, start);
		const tag = /<details\b|<\/details>/g;
		tag.lastIndex = start;
		let depth = 0;
		let end = html.length;
		for (let match = tag.exec(html); match; match = tag.exec(html)) {
			depth += match[0] === "</details>" ? -1 : 1;
			if (depth === 0) {
				end = tag.lastIndex;
				break;
			}
		}
		worked += html.slice(start, end);
		at = end;
	}
	return { worked, outside: outside + html.slice(at) };
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
		expect(html).toContain('data-verb="finished">finished</span>');
		expect(html).not.toContain("[agent 3");
		expect(html).toContain(
			'<span class="helper-card-line">Parser fixed.</span>',
		);
		expect(html).toContain(
			'title="Parser fixed.\n\n12 steps · 6m · 362k tokens"',
		);
	});

	it("says failed on a failed helper's card, in its own colour", () => {
		const task = {
			id: "h1",
			parentSessionId: "root",
			title: "Fix the parser",
			label: "Task 1",
			depth: 1,
			status: "failed",
			prompt: "",
			placement: "fresh",
			access: "read_write",
			summary: null,
			harnessId: "api",
			listedModelId: null,
			createdAt: new Date(1_000).toISOString(),
			updatedAt: new Date(2_000).toISOString(),
			items: [
				{
					kind: "error",
					id: SessionItemId("err"),
					message: "Budget ran out",
				},
			],
			turnStatus: "failed",
		} as AgentTaskActivity;
		const html = render(
			[user("ask"), spawn, answer("a1", "Started a helper.")],
			"completed",
			[task],
		);
		expect(html).toContain('class="helper-card" data-status="failed"');
		expect(html).toContain(
			'<span class="helper-card-verb" data-verb="failed">failed</span> · Fix the parser',
		);
		expect(html).toContain(
			'<span class="helper-card-line">Budget ran out</span>',
		);
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

/**
 * Wake-up turns as the browser really gets them: the server stores the
 * hidden child-event message (deliverParentTaskNotification through
 * sessionItemsQueuedWithUser), and every read the browser makes (reload,
 * live progress snapshot) projects the stored items with childTaskPublicItems.
 */
describe("session timeline with server-started wake-up turns", () => {
	const stored = (items: readonly SessionItem[]) =>
		childTaskPublicItems(
			sessionItemsFromUnknown(JSON.parse(JSON.stringify(items))),
		);
	const done = (items: readonly SessionItem[], at: number) =>
		settledTurnItems(items, at);
	const helperChat = () => {
		let items: SessionItem[] = sessionItemsQueuedWithUser(
			[],
			"Start a slow build helper",
			"m1",
		);
		items = done(
			[...items, spawn, answer("a1", "Started the build helper.")],
			Date.now(),
		);
		items = sessionItemsQueuedWithUser(items, "What is 391 plus fruit?", "m2");
		items = done([...items, answer("a2", "391 PINEAPPLE")], Date.now());
		return sessionItemsQueuedWithUser(
			items,
			childTaskEventQueueText("6f1c2a9e-0d4b-4c51-9a63-2f8f5b1d7e10"),
		);
	};
	const check: SessionItem = {
		kind: "dynamicToolCall",
		id: SessionItemId("check"),
		tool: "bash",
		status: "completed",
	};

	it("keeps Main's answer outside Worked while a helper's report turn runs", () => {
		const html = render(stored([...helperChat(), check]), "running");
		const { worked, outside } = split(html);
		expect(outside).toContain("391 PINEAPPLE");
		expect(worked).not.toContain("391 PINEAPPLE");
		expect(html).not.toContain("ytimesy-child-event");
	});

	it("keeps it there after the report turn ends and on reload", () => {
		const html = render(
			stored(
				done(
					[...helperChat(), check, answer("a3", "The build passed.")],
					Date.now(),
				),
			),
			"completed",
		);
		const { worked, outside } = split(html);
		expect(outside).toContain("391 PINEAPPLE");
		expect(outside).toContain("The build passed.");
		expect(worked).not.toContain("391 PINEAPPLE");
	});

	it("sets an answer-only report turn apart from Main's previous answer", () => {
		const html = render(
			stored(
				done([...helperChat(), answer("a3", "The build passed.")], Date.now()),
			),
			"completed",
		);
		const before = html.indexOf("391 PINEAPPLE");
		const breakAt = html.indexOf('class="session-turn-break"');
		const after = html.indexOf("The build passed.");
		expect(before).toBeGreaterThan(-1);
		expect(breakAt).toBeGreaterThan(before);
		expect(after).toBeGreaterThan(breakAt);
		expect(html.match(/session-turn-break/g)).toHaveLength(1);
		expect(html).not.toContain("ytimesy-child-event");
	});

	it("keeps Main's Started message outside Worked when a command's exit wakes it", () => {
		const startedAt = Date.now() - 60_000;
		const background: SessionItem = {
			kind: "dynamicToolCall",
			id: SessionItemId("bg"),
			tool: "bash",
			input: JSON.stringify({ command: "pnpm build", background: true }),
			status: "completed",
			background: { id: "cmd1", label: "pnpm build", startedAt },
		};
		let items: SessionItem[] = sessionItemsQueuedWithUser(
			[],
			"Run the build in the background",
			"m1",
		);
		items = done(
			[...items, background, answer("a1", "Started pnpm build.")],
			Date.now(),
		);
		items = withBackgroundCommandExits(items, [
			{
				id: "cmd1",
				label: "pnpm build",
				startedAt,
				endedAt: Date.now(),
				exitCode: 0,
				outputPath: "/tmp/ytimesy-detached/cmd1/output",
				lastLines: "done",
				announced: true,
			},
		]);
		items = sessionItemsQueuedWithUser(
			items,
			childTaskEventQueueText("bg:cmd1"),
		);
		const html = render(
			stored([...items, check, answer("a2", "The build finished cleanly.")]),
			"completed",
		);
		const { worked, outside } = split(html);
		expect(outside).toContain("Started pnpm build.");
		expect(worked).not.toContain("Started pnpm build.");
		expect(outside).toContain("The build finished cleanly.");
	});
});

describe("session timeline plan checklist", () => {
	const asked: SessionItem = {
		kind: "userMessage",
		id: SessionItemId("user"),
		text: "Migrate billing",
	};
	const updated = (status: "in_progress" | "completed") =>
		applyPlanUpdate(
			[asked, readCall("turn:read", "completed", "read")],
			"turn",
			{
				plan: [
					{ step: "Read the schema", status },
					{
						step: "Write the migration",
						status: status === "completed" ? "in_progress" : "pending",
					},
				],
			},
		);

	it("shows one live checklist while the turn runs, updated in place", () => {
		const items = applyPlanUpdate(updated("in_progress"), "turn", {
			plan: [
				{ step: "Read the schema", status: "completed" },
				{ step: "Write the migration", status: "in_progress" },
			],
		});
		const html = renderTimeline(items, "running");
		expect(html.match(/aria-label="Todos"/g)).toHaveLength(1);
		expect(html).toContain("<s>Read the schema</s>");
		expect(html).toContain("Write the migration");
	});

	it("folds the checklist into Worked once the turn ends", () => {
		const html = renderTimeline(
			[
				...updated("completed"),
				{
					kind: "agentMessage",
					id: SessionItemId("turn:answer"),
					text: "Migrated.",
				},
			],
			"completed",
		);
		// Inside the Worked group, above the answer that stays in view.
		const todos = html.indexOf('aria-label="Todos"');
		expect(html.indexOf("Worked")).toBeGreaterThan(-1);
		expect(html.indexOf("Worked")).toBeLessThan(todos);
		expect(todos).toBeLessThan(html.indexOf("Migrated."));
	});
});
