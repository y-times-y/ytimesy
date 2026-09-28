import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentCompetition } from "#/domain/agent-competition";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { SessionTimeline } from "./session-timeline";

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
	it("places expandable agent work under its prompt and the judge after both agents finish", () => {
		const items: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("task-one"),
				text: "Make a change",
			},
			{
				kind: "agentMessage",
				id: SessionItemId("judge-answer"),
				text: "Agent 2 is better",
			},
		];
		const group: AgentCompetition = {
			id: "group-one",
			rootSessionId: "root",
			userMessageId: "task-one",
			prompt: "Make a change",
			leaderCount: 2,
			status: "working",
			winnerSessionId: null,
			errorMessage: null,
			candidates: [
				{
					id: "first",
					index: 1,
					status: "done",
					summary: "First result",
					items: [],
				},
				{ id: "second", index: 2, status: "working", summary: null, items: [] },
			],
		};
		const working = renderToString(
			createElement(SessionTimeline, {
				items,
				turnStatus: "running",
				competitions: [group],
			}),
		);
		expect(working).toContain('<details class="competition-candidate"');
		expect(working).not.toContain("Judge reviewing results");
		const finished = renderToString(
			createElement(SessionTimeline, {
				items,
				turnStatus: "completed",
				competitions: [
					{
						...group,
						status: "complete",
						winnerSessionId: "second",
						candidates: [
							group.candidates[0],
							{
								...group.candidates[1],
								status: "done",
								summary: "Second result",
							},
						],
					},
				],
			}),
		);
		expect(finished.indexOf("Make a change")).toBeLessThan(
			finished.indexOf("Agent 1"),
		);
		expect(finished.indexOf("Agent 2")).toBeLessThan(
			finished.indexOf("Judge selected Agent 2"),
		);
		expect(finished.indexOf("Judge selected Agent 2")).toBeLessThan(
			finished.indexOf("Agent 2 is better"),
		);
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
