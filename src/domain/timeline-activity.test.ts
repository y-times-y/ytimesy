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
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-1"),
				tool: "read_file",
				status: "completed",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-2"),
				tool: "read",
				status: "completed",
			},
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
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-3"),
				tool: "view",
				status: "completed",
			},
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

	it("keeps file edits as coding activity instead of Explored", () => {
		expect(isExplorationItem(fileChange("f1", "src/a.ts"))).toBe(false);
		const rows = groupTimelineRows([
			fileChange("f1", "src/a.ts"),
			{
				kind: "dynamicToolCall",
				id: SessionItemId("read-1"),
				tool: "read_file",
				status: "completed",
			},
			fileChange("f2", "src/b.ts"),
		]);
		expect(rows.map((row) => row.kind)).toEqual([
			"item",
			"exploration",
			"item",
		]);
		expect(rows[0]).toMatchObject({
			kind: "item",
			item: { kind: "fileChange" },
		});
		expect(rows[2]).toMatchObject({
			kind: "item",
			item: { kind: "fileChange" },
		});
	});
});
