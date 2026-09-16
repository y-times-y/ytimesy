import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

	it("color-codes mentioned files so clicking them opens the diff", () => {
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
		expect(html).toContain('data-change="update"');
		expect(html).toContain("src/styles.css");
	});
});
