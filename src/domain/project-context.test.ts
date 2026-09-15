import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	completedTurnUpdatesProjectContext,
	nextProjectBriefing,
	projectContextDocument,
	promptTextWithProjectContext,
	relatedTracesForTask,
	traceAreaFromTask,
	traceAreaFromTurn,
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

	it("puts the newest durable briefing line first for the next agent", () => {
		expect(
			projectContextDocument({
				briefing: [
					"Lockfile installs use corepack.",
					"Reply with exactly ytimesy-ctx-1a0a3daa754: ytimesy-ctx-1a0a3daa754",
					"Reply with exactly turn-text-proof-58b4: turn-text-proof-58b4",
				].join("\n"),
				traces: [],
			}),
		).toBe(
			["## Project briefing", "Lockfile installs use corepack."].join("\n"),
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

	it("drops exact-reply pings unless they touched a repo area", () => {
		expect(
			relatedTracesForTask(
				[
					{
						area: null,
						summary:
							"Reply with exactly ytimesy-ctx-1a0a3daa754 and nothing else. Do not edit files.: ytimesy-ctx-1a0a3daa754",
					},
					{
						area: "PARALLEL_A.md",
						summary: "Create PARALLEL_A.md: parallel-a-ok",
					},
				],
				"Reply with exactly the leftover-reply follow-up answer",
			),
		).toEqual([
			{
				area: "PARALLEL_A.md",
				summary: "Create PARALLEL_A.md: parallel-a-ok",
			},
		]);
	});
});

describe("traceAreaFromTurn", () => {
	it("uses a path named in the task when the tree has no this-turn edits", () => {
		expect(traceAreaFromTask("Create PARALLEL_A.md with parallel-a-ok.")).toBe(
			"PARALLEL_A.md",
		);
		expect(
			traceAreaFromTurn({
				task: "Add src/domain/snapshot-copy-proof.ts for the copy proof.",
				items: [],
			}),
		).toBe("src/domain/snapshot-copy-proof.ts");
	});

	it("uses this turn's file changes over an older path in the task", () => {
		expect(
			traceAreaFromTurn({
				task: "Also mention FOLLOWUP_RESUME.md",
				items: [
					{
						kind: "userMessage",
						id: SessionItemId("u1"),
						text: "Write the copy proof",
					},
					{
						kind: "fileChange",
						id: SessionItemId("f1"),
						status: "completed",
						changes: [
							{
								path: "src/domain/snapshot-copy-proof.ts",
								change: "add",
								additions: 3,
								deletions: 0,
								preview: null,
							},
							{
								path: "src/domain/snapshot-copy-proof.test.ts",
								change: "add",
								additions: 8,
								deletions: 0,
								preview: null,
							},
						],
					},
				],
			}),
		).toBe("src/domain");
	});
});

describe("completedTurnUpdatesProjectContext", () => {
	it("does not store a short token reply with no repo area", () => {
		expect(
			completedTurnUpdatesProjectContext({
				area: null,
				task: "A sibling just finished a leftover-reply follow-up. Reply with exactly that follow-up's answer.",
				reply: "ytimesy-ctx-1a0a3daa754",
			}),
		).toBe(false);
	});

	it("keeps a turn that edited the repo even if the reply is short", () => {
		expect(
			completedTurnUpdatesProjectContext({
				area: "PARALLEL_A.md",
				task: "Create PARALLEL_A.md containing parallel-a-ok.",
				reply: "done",
			}),
		).toBe(true);
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
