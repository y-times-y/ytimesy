import { describe, expect, it } from "vitest";
import {
	nextProjectBriefing,
	projectContextDocument,
	promptTextWithProjectContext,
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
					{
						area: null,
						summary:
							"Seal the snapshot: Wrote template_snapshot_id.\nHow: Copy from the unused template.",
					},
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
				"- Seal the snapshot: Wrote template_snapshot_id.\nHow: Copy from the unused template.",
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

	it("keeps sibling reasoning, not only the compacted reply", () => {
		expect(
			traceSummaryFromTurn({
				task: "Seal the snapshot",
				reply: "Wrote template_snapshot_id after pnpm install.",
				reasoning: [
					"Agents copy from the unused template, never from a dirty checkout.",
				],
			}),
		).toBe(
			"Seal the snapshot: Wrote template_snapshot_id after pnpm install.\nHow: Agents copy from the unused template, never from a dirty checkout.",
		);
	});
});

describe("nextProjectBriefing", () => {
	it("starts from the first completed turn", () => {
		expect(
			nextProjectBriefing({
				briefing: "  ",
				summary: "OpenCode serve must start in the checkout.",
			}),
		).toBe("OpenCode serve must start in the checkout.");
	});

	it("does not duplicate a summary the briefing already has", () => {
		expect(
			nextProjectBriefing({
				briefing: "OpenCode serve must start in the checkout.",
				summary: "OpenCode serve must start in the checkout.",
			}),
		).toBe("OpenCode serve must start in the checkout.");
	});

	it("keeps only the latest briefing lines", () => {
		expect(
			nextProjectBriefing({
				briefing: ["a", "b", "c", "d", "e", "f"].join("\n"),
				summary: "g",
			}),
		).toBe(["b", "c", "d", "e", "f", "g"].join("\n"));
	});
});

describe("promptTextWithProjectContext", () => {
	it("leaves the task unchanged when there is no shared context", () => {
		expect(
			promptTextWithProjectContext({
				task: "Fix the desktop viewer",
				document: "  ",
			}),
		).toBe("Fix the desktop viewer");
	});

	it("prepends sibling briefing without replacing the task", () => {
		expect(
			promptTextWithProjectContext({
				task: "Fix the desktop viewer",
				document: "## Project briefing\nnoVNC maps display :0",
			}),
		).toBe(
			[
				"Shared project context from sibling agents:",
				"",
				"## Project briefing",
				"noVNC maps display :0",
				"",
				"---",
				"",
				"Fix the desktop viewer",
			].join("\n"),
		);
	});
});
