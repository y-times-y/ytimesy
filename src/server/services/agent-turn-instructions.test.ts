import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentTurnInstructions } from "./agent-turn-instructions";

const stub = tool({
	description: "stub",
	inputSchema: z.object({}),
	execute: async () => "",
});

const base = {
	shellBuilder: true,
	plugins: [],
	projectKnowledge: null,
	leanShape: "core" as const,
	leanWorkingDirectory: "/home/user/app",
};

describe("subagent instructions", () => {
	it("teaches the builder cost-aware orchestration only when it has the agent tool", () => {
		const without = agentTurnInstructions({
			...base,
			session: { parentSessionId: null },
			tools: { bash: stub },
		});
		expect(without).not.toContain("Subagents:");
		const withAgent = agentTurnInstructions({
			...base,
			session: { parentSessionId: null },
			tools: { bash: stub, agent: stub, run_code: stub },
			deferredTools: [
				{ name: "agent", description: "Start a subagent." },
				{ name: "propose_plan", description: "Propose a plan." },
			],
		});
		expect(withAgent).toContain(
			"More tools are available on demand; they are not in your tool list until you load one with find_tools",
		);
		expect(withAgent).toContain(
			"- agent: Start a subagent.\n- propose_plan: Propose a plan.",
		);
		expect(withAgent).toContain(
			"load it with find_tools, or call it from run_code",
		);
		// Concrete triggers, the call's arguments and one parallel example.
		expect(withAgent).toContain(
			"two or more independent parts, each likely to take over 5 minutes, or a long build or test run beside a fix: start writers in parallel",
		);
		expect(withAgent).toContain(
			'start them together from one run_code program: await Promise.all([tools.agent({ role: "writer"',
		);
		expect(withAgent).toContain(
			'agent({ role: "writer" | "researcher" | "reviewer" | "checker", title: string, brief?: string, wait?: boolean })',
		);
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

	it("in code mode primary, teaches run_code as the main tool and sends deferred tools through it", () => {
		const primary = agentTurnInstructions({
			...base,
			session: { parentSessionId: null },
			tools: { bash: stub, agent: stub, run_code: stub },
			deferredTools: [{ name: "agent", description: "Start a subagent." }],
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
		expect(primary).toContain("call it from run_code: tools.agent(args)");
		expect(primary).not.toContain("find_tools");
	});

	it("gives a subagent its role, budget and report contract instead of the chat's role", () => {
		const reviewer = agentTurnInstructions({
			...base,
			session: {
				parentSessionId: "root",
				taskAccess: "read_only",
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
				parentSessionId: "root",
				taskAccess: "read_write",
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
			session: { parentSessionId: null },
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
				parentSessionId: "root",
				taskAccess: "read_only",
				agentRole: "researcher",
				agentBudget: null,
			},
			tools: { bash: stub, read: stub, agent: stub, run_code: stub },
			codeMode: "primary",
		});
		expect(researcher).toContain(
			'agent({ role: "researcher" | "reviewer" | "checker",',
		);
		expect(researcher).toContain('tools.agent({ role: "researcher"');
		expect(researcher).not.toMatch(/writer|git apply/);
	});
});
