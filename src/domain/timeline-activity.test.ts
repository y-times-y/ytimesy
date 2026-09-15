import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	explorationLabel,
	groupTimelineRows,
	isExplorationItem,
} from "./timeline-activity";

function fileChange(id: string, path: string): SessionItem {
	return {
		kind: "fileChange",
		id: SessionItemId(id),
		status: "completed",
		changes: [
			{
				path,
				change: "update",
				additions: 1,
				deletions: 0,
				preview: "ok\n",
			},
		],
	};
}

describe("timeline activity grouping", () => {
	it("treats file reads and searches as exploration, not shell pills", () => {
		const read: SessionItem = {
			kind: "dynamicToolCall",
			id: SessionItemId("read-1"),
			tool: "read_file",
			status: "completed",
		};
		const search: SessionItem = {
			kind: "webSearch",
			id: SessionItemId("web-1"),
			query: "agent-browser",
		};
		const shell: SessionItem = {
			kind: "commandExecution",
			id: SessionItemId("cmd-1"),
			command: "ls",
			cwd: "/tmp",
			status: "completed",
			output: null,
			exitCode: 0,
		};
		expect(isExplorationItem(read)).toBe(true);
		expect(isExplorationItem(search)).toBe(true);
		expect(isExplorationItem(shell)).toBe(false);
	});

	it("collapses consecutive reads and searches into one Explored row", () => {
		const items: SessionItem[] = [
			fileChange("f1", "src/a.ts"),
			fileChange("f2", "src/b.ts"),
			{
				kind: "webSearch",
				id: SessionItemId("s1"),
				query: "layout",
			},
			{
				kind: "commandExecution",
				id: SessionItemId("cmd-1"),
				command: "pnpm test",
				cwd: "/tmp",
				status: "inProgress",
				output: null,
				exitCode: null,
			},
			fileChange("f3", "src/c.ts"),
		];
		const rows = groupTimelineRows(items);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			kind: "exploration",
			counts: { files: 2, searches: 1 },
		});
		expect(explorationLabel({ files: 2, searches: 1 })).toBe(
			"Explored 2 files 1 search",
		);
		expect(rows[1]).toMatchObject({
			kind: "item",
			item: { kind: "commandExecution" },
		});
		expect(rows[2]).toMatchObject({
			kind: "exploration",
			counts: { files: 1, searches: 0 },
		});
		expect(explorationLabel({ files: 1, searches: 0 })).toBe("Explored 1 file");
	});
});
