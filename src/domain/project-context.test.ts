import { describe, expect, it } from "vitest";
import {
	projectContextDocument,
	relatedTracesForTask,
	traceSummaryFromTurn,
} from "./project-context";

describe("projectContextDocument", () => {
	it("omits empty briefing and traces", () => {
		expect(projectContextDocument({ briefing: "  ", traces: [] })).toBe("");
	});

	it("renders briefing and sibling traces for the next agent", () => {
		expect(
			projectContextDocument({
				briefing: "Lockfile installs use corepack.",
				traces: [
					{ area: "prepare", summary: "nvm must be sourced before pnpm" },
					{ area: null, summary: "  " },
				],
			}),
		).toBe(
			[
				"## Project briefing",
				"Lockfile installs use corepack.",
				"",
				"## Related traces",
				"- prepare: nvm must be sourced before pnpm",
			].join("\n"),
		);
	});
});

describe("relatedTracesForTask", () => {
	const traces = [
		{
			area: "auth",
			summary: "GitHub App installation tokens clone private repos",
		},
		{ area: "desktop", summary: "noVNC maps display :0" },
		{ area: "diff", summary: "git status --porcelain feeds the inspector" },
	];

	it("prefers traces that share words with the new task", () => {
		expect(relatedTracesForTask(traces, "fix the desktop viewer")).toEqual([
			traces[1],
		]);
	});

	it("falls back to recent traces when nothing matches", () => {
		expect(relatedTracesForTask(traces, "xyz")).toEqual(traces);
	});
});

describe("traceSummaryFromTurn", () => {
	it("keeps a short briefing update, not the full transcript", () => {
		expect(
			traceSummaryFromTurn({
				task: "Seal the snapshot",
				reply: "Wrote template_snapshot_id after pnpm install.",
			}),
		).toBe("Seal the snapshot: Wrote template_snapshot_id after pnpm install.");
	});
});
