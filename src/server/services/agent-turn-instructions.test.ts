import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { beginSidekickRound, newSidekickState } from "#/domain/sidekick";
import { agentTurnInstructions } from "./agent-turn-instructions";

const stub = tool({
	description: "stub",
	inputSchema: z.object({}),
	execute: async () => "",
});

const base = {
	plugins: [],
	projectKnowledge: null,
	leanShape: "core" as const,
	leanWorkingDirectory: "/home/user/app",
};

describe("subagent instructions", () => {
	it("teaches the builder cost-aware orchestration only when it has the agent tool", () => {
		const without = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub },
		});
		expect(without).not.toContain("Subagents:");
		const withAgent = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub, agent: stub, run_code: stub },
			codeMode: "on",
		});
		// agent is an ordinary tool: no loading, no deferred list.
		expect(withAgent).toContain(
			"Subagents: `agent` starts a background agent with only your brief and returns its id at once;",
		);
		expect(withAgent).not.toMatch(/find_tools|searchTools|More tools/);
		// Concrete triggers and one parallel example (arguments come from the schema).
		expect(withAgent).toContain(
			"two or more independent parts, each likely to take over 5 minutes, or a long build or test run beside a fix: start writers in parallel",
		);
		expect(withAgent).toContain(
			'start them together from one run_code program: await Promise.all([tools.agent({ role: "writer"',
		);
		expect(withAgent).not.toContain("Arguments: agent(");
		expect(withAgent).toContain(
			"after a hard fix, a reviewer can check it while you run the suite yourself",
		);
		expect(withAgent).toContain(
			"small, quick or sequential work, or anything you would finish in a few steps, you do yourself",
		);
		expect(withAgent).not.toContain("Cost first");
		// The root role line allows what the block describes.
		expect(withAgent).toContain(
			"answer the user yourself, delegating only as below.",
		);
		expect(withAgent).not.toContain("work directly in this workspace");
		expect(without).toContain("work directly in this workspace");
		expect(without).not.toContain("delegating");
		expect(withAgent).toContain("what not to touch");
		expect(withAgent).toContain("disjoint file set");
		expect(withAgent).toContain("a report is a claim, not a fact");
		expect(withAgent).toContain("git apply -3");
	});

	it("in code mode primary, teaches run_code as the main tool and sends only deferred MCP tools through it", () => {
		const primary = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub, agent: stub, run_code: stub },
			deferredTools: [
				{ name: "search_mcp_tools", description: "Search MCP tools." },
			],
			codeMode: "primary",
		});
		expect(primary).toContain("run_code is your main tool");
		expect(primary).toContain(
			"Your tools: run_code runs programs that call bash, read, edit and write; bash runs shell commands;",
		);
		expect(primary).toContain(
			"Explore with one run_code program: list the tree and read the task's files with Promise.all.",
		);
		expect(primary).toContain(
			"Once you know the fix, make all planned edits and run the tests in ONE run_code program.",
		);
		expect(primary).not.toContain("run_code runs one JavaScript program");
		expect(primary).toContain(
			"call them from inside run_code as tools.<name>(args)",
		);
		expect(primary).toContain("- search_mcp_tools: Search MCP tools.");
		expect(primary).not.toContain("call it from run_code");
		expect(primary).not.toContain("find_tools");
		// Nothing deferred: searchTools goes unmentioned.
		const nothingDeferred = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub, agent: stub, run_code: stub },
			deferredTools: [],
			codeMode: "primary",
		});
		expect(nothingDeferred).not.toMatch(/searchTools|ALL_TOOLS|find_tools/);
		expect(nothingDeferred).toContain("Subagents: `agent` starts");
	});

	it("gives a subagent its role, budget and report contract instead of the chat's role", () => {
		const reviewer = agentTurnInstructions({
			...base,
			session: {
				agentRole: "reviewer",
				agentBudget: { steps: 75, minutes: 15, tokens: 1_000_000 },
			},
			tools: { bash: stub },
		});
		expect(reviewer).toContain("read-only reviewer subagent");
		expect(reviewer).toContain("75 steps, 15 minutes, 1,000,000 tokens");
		expect(reviewer).toContain("You see only your brief");
		expect(reviewer).not.toContain("You are the coding agent for this chat");
		expect(reviewer).not.toContain("draft PRs");
		const writer = agentTurnInstructions({
			...base,
			session: {
				agentRole: "writer",
				agentBudget: null,
			},
			tools: { bash: stub },
		});
		expect(writer).toContain(
			"receives your work as a patch to review and apply",
		);
		expect(writer).not.toContain("push");
	});

	it("without code mode, asks for direct parallel agent calls; a reader never starts writers", () => {
		const direct = agentTurnInstructions({
			...base,
			session: {},
			tools: { bash: stub, agent: stub },
		});
		expect(direct).toContain(
			"start them together: call agent once per part in the same step",
		);
		expect(direct).not.toContain("run_code");
		const researcher = agentTurnInstructions({
			...base,
			leanReadOnly: true,
			session: {
				agentRole: "researcher",
				agentBudget: null,
			},
			tools: { bash: stub, read: stub, agent: stub, run_code: stub },
			codeMode: "primary",
		});
		expect(researcher).toContain(
			"You may start only researchers, reviewers and checkers.",
		);
		expect(researcher).toContain('tools.agent({ role: "researcher"');
		expect(researcher).not.toMatch(/writer|git apply/);
	});
});

describe("lead mode fusion instructions", () => {
	const lead = (
		leanShape: "core" | "codex" | "claude",
		tools: Record<string, typeof stub>,
		variant?: "off" | "fusion",
	) =>
		agentTurnInstructions({
			...base,
			leanShape,
			session: {},
			tools,
			lead: variant,
		});

	it("replaces the orchestration block with the lead's for the root builder", () => {
		const fusion = lead(
			"core",
			{
				bash: stub,
				read: stub,
				edit: stub,
				write: stub,
				agent: stub,
				agent_send: stub,
			},
			"fusion",
		);
		expect(fusion).toContain("Subagents: you are the lead.");
		expect(fusion).toContain(
			"Short or trivial tasks (a few steps, one obvious change): do them yourself",
		);
		expect(fusion).toContain(
			"the definition of done as concrete checks or commands that must pass",
		);
		expect(fusion).toContain(
			"send specific feedback with `agent_send` (what fails, where, what done looks like) for another round instead of fixing it yourself",
		);
		expect(fusion).toContain(
			"Take over and edit yourself (`edit`, `write`) only when the sidekick has failed twice on the same issue or is clearly out of its depth.",
		);
		expect(fusion).toContain("git add -A && git apply -3 <patch>");
		// Not the default block's delegation policy.
		expect(fusion).not.toContain("Delegate when it saves wall-clock time");
		expect(fusion).toContain(
			"answer the user yourself, delegating only as below.",
		);
		const off = lead("core", { bash: stub, edit: stub, agent: stub }, "off");
		expect(off).toContain("Delegate when it saves wall-clock time");
		expect(off).not.toContain("you are the lead");
	});

	it("names the surface's own editing tools", () => {
		expect(
			lead(
				"codex",
				{ exec_command: stub, apply_patch: stub, agent: stub },
				"fusion",
			),
		).toContain("Take over and edit yourself (`apply_patch`) only when");
		expect(
			lead(
				"claude",
				{ Bash: stub, Edit: stub, Write: stub, agent: stub },
				"fusion",
			),
		).toContain("Take over and edit yourself (`Edit`, `Write`) only when");
	});

	it("gives the sidekick its persistent role and per-round budget, never the lead's block", () => {
		const budget = { steps: 150, minutes: 30, tokens: 2_000_000 };
		const sidekick = agentTurnInstructions({
			...base,
			session: {
				agentRole: "writer",
				agentBudget: {
					...budget,
					sidekick: newSidekickState(budget, "2026-10-19T10:00:00.000Z"),
				},
			},
			tools: { bash: stub, edit: stub },
			lead: "fusion",
		});
		expect(sidekick).toContain("You are the lead's sidekick");
		expect(sidekick).toContain(
			"Your budget per round: 150 steps, 30 minutes, 1,000,000 tokens; 6 rounds at most.",
		);
		expect(sidekick).toContain("you start no agents");
		expect(sidekick).not.toContain("you are the lead");
		// Static across rounds: the round's state never enters the prompt.
		const later = agentTurnInstructions({
			...base,
			session: {
				agentRole: "writer",
				agentBudget: {
					...budget,
					sidekick: beginSidekickRound(
						newSidekickState(budget, "2026-10-19T10:00:00.000Z"),
						{
							now: "2026-10-19T10:20:00.000Z",
							steps: 40,
							tokens: 9,
							sync: "clean",
						},
					),
				},
			},
			tools: { bash: stub, edit: stub },
			lead: "fusion",
		});
		expect(later).toBe(sidekick);
	});
});
