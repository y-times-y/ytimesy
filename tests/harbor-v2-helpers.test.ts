import { describe, expect, it } from "vitest";
import {
	AGENT_WAIT_TOOL,
	HELPER_INSTRUCTIONS,
	type HelperRole,
	helperTools,
	MAX_LIVE_HELPERS,
	WRITE_HELPER_INSTRUCTIONS,
	writesOutside,
} from "../evals/harbor_v2/helpers";
import type { ChildReport, ChildSession } from "../evals/harbor_v2/sessions";
import { trialSessions } from "../evals/harbor_v2/sessions";
import {
	BRIEF_POLICY,
	KEEP_WORKING_POLICY,
	READER_DELEGATION_POLICY,
	REFUSED_START,
	REPORT_IS_A_CLAIM,
	WRITER_DELEGATION_POLICY,
} from "../src/domain/delegation-policy";
import { modelBilling } from "../src/domain/model-pricing";
import {
	PLAN_TOOL,
	planSummary,
	planTool,
} from "../src/server/services/plan-tool";

const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
	(
		tools[name] as { execute: (i: unknown, o: unknown) => Promise<string> }
	).execute(input, { toolCallId: "t", messages: [] });

const model = {
	modelId: "claude-opus-5-5",
	effort: "max" as const,
	billing: modelBilling({ harness: "api", modelId: "claude-opus-5-5" }),
};

/** A start that resolves each round when the test says so. */
function controlledStart() {
	const rounds: {
		session: ChildSession;
		role: HelperRole;
		brief: string;
		finish: (report: ChildReport) => void;
	}[] = [];
	const start = (session: ChildSession, role: HelperRole, brief: string) =>
		new Promise<ChildReport>((resolve) => {
			session.stop = () => resolve({ outcome: "completed", report: "partial" });
			rounds.push({ session, role, brief, finish: resolve });
		});
	return { rounds, start };
}

describe("helperTools (helpers=on)", () => {
	it("starts read-only helpers in the background and returns each report once", async () => {
		const sessions = trialSessions();
		const { rounds, start } = controlledStart();
		const tools = helperTools({ parentId: "trial", sessions, model, start });
		expect(Object.keys(tools)).toEqual([
			"agent",
			AGENT_WAIT_TOOL,
			"agent_send",
		]);
		expect(
			await run(tools, "agent", {
				role: "researcher",
				title: "Find loader",
				brief: "Find the config loader.",
			}),
		).toBe(
			"Started agent trial.1 (researcher): Find loader. Collect its report with agent_wait.",
		);
		expect(sessions.get("trial.1")).toMatchObject({
			role: "helper",
			parentId: "trial",
			briefs: ["Find the config loader."],
		});
		expect(rounds[0].role).toBe("researcher");
		const waiting = run(tools, AGENT_WAIT_TOOL, {});
		rounds[0].finish({ outcome: "completed", report: "src/config.ts:12" });
		expect(await waiting).toBe(
			"Agent trial.1 (researcher) reported:\nsrc/config.ts:12",
		);
		expect(await run(tools, AGENT_WAIT_TOOL, {})).toMatch(
			/^No reports to collect/,
		);
		// Briefed again, it keeps its session.
		expect(
			await run(tools, "agent_send", {
				id: "trial.1",
				message: "Now the tests.",
			}),
		).toBe("Agent trial.1 briefed again. Collect its report with agent_wait.");
		expect(rounds[1].session).toBe(rounds[0].session);
		rounds[1].finish({ outcome: "failed", report: "" });
		expect(await run(tools, AGENT_WAIT_TOOL, { id: "trial.1" })).toBe(
			"Agent trial.1 (researcher) failed:\n(no report)",
		);
	});

	it("blocks with wait, stops on agent_send, refuses writers and a fifth live helper", async () => {
		const sessions = trialSessions();
		const { rounds, start } = controlledStart();
		const tools = helperTools({ parentId: "trial", sessions, model, start });
		const waited = run(tools, "agent", {
			role: "reviewer",
			title: "Review",
			brief: "Review the diff.",
			wait: true,
		});
		await Promise.resolve();
		rounds[0].finish({ outcome: "completed", report: "No problems." });
		expect(await waited).toBe(
			"Agent trial.1 (reviewer) reported:\nNo problems.",
		);
		for (let index = 0; index < MAX_LIVE_HELPERS; index++)
			await run(tools, "agent", {
				role: "researcher",
				title: "R",
				brief: "Look.",
			});
		expect(
			await run(tools, "agent", {
				role: "researcher",
				title: "R",
				brief: "Look.",
			}),
		).toMatch(/^Refused: 4 helpers are already running/);
		expect(
			await run(tools, "agent_send", { id: "trial.2", stop: true }),
		).toMatch(/stopped/);
		expect(await run(tools, AGENT_WAIT_TOOL, { id: "trial.2" })).toBe(
			"Agent trial.2 (researcher) reported:\npartial",
		);
		expect(await run(tools, "agent_send", { id: "nope", stop: true })).toMatch(
			/^No agent nope of yours/,
		);
		// Only the two reader roles exist: a writer fails input validation.
		const schema = (tools.agent as { inputSchema: { validate?: unknown } })
			.inputSchema;
		expect(JSON.stringify(schema)).not.toContain('"writer"');
	});
});

describe("helperTools (helpers=write)", () => {
	it("starts a writer only with owns, as a writer session, and keeps readers read-only", async () => {
		const sessions = trialSessions();
		const owned: (readonly string[] | undefined)[] = [];
		const { rounds, start } = controlledStart();
		const tools = helperTools({
			parentId: "trial",
			sessions,
			model,
			writers: true,
			start: (session, role, brief, owns) => {
				owned.push(owns);
				return start(session, role, brief);
			},
		});
		expect(
			await run(tools, "agent", {
				role: "writer",
				title: "Part A",
				brief: "Build part A.",
			}),
		).toBe(
			"Refused: a writer needs owns, the files or directories it may change.",
		);
		expect(sessions.all()).toHaveLength(0);
		expect(
			await run(tools, "agent", {
				role: "writer",
				title: "Part A",
				brief: "Build part A.",
				owns: [" src/a/ ", ""],
			}),
		).toBe(
			"Started agent trial.1 (writer): Part A. Collect its report with agent_wait.",
		);
		expect(
			await run(tools, "agent", {
				role: "researcher",
				title: "R",
				brief: "Look.",
				owns: ["ignored.py"],
			}),
		).toMatch(/^Started agent trial.2 \(researcher\)/);
		expect(sessions.all().map((session) => session.role)).toEqual([
			"writer",
			"helper",
		]);
		expect(owned).toEqual([["src/a/"], undefined]);
		expect(rounds.map((round) => round.role)).toEqual(["writer", "researcher"]);
		// Briefed again, a writer keeps its paths.
		rounds[0].finish({ outcome: "completed", report: "Part A done." });
		expect(await run(tools, AGENT_WAIT_TOOL, { id: "trial.1" })).toBe(
			"Agent trial.1 (writer) reported:\nPart A done.",
		);
		await run(tools, "agent_send", { id: "trial.1", message: "Fix the test." });
		expect(owned[2]).toEqual(["src/a/"]);
		expect(JSON.stringify(tools.agent)).toContain('"owns"');
	});

	it("composes the helpers=write section from the product's delegation policy, as measured", () => {
		// The exact text of the middle rule as measured on 2026-10-28 (the
		// delegation probe and the Terminal-Bench trigger runs); the strict
		// writer and reader rules measured on 2026-10-27 it replaced are in
		// docs/research/delegation-middle-rule-2026-10-28.md.
		expect(WRITE_HELPER_INSTRUCTIONS).toBe(
			[
				"Helpers: `agent` starts a helper in the background with only your brief and returns its id at once: a researcher or reviewer (read-only, on its own copy of your checkout) or a writer (in your own checkout, changing only the paths you list in `owns`). `agent_wait` collects reports; `agent_send` stops a helper or briefs a finished one again.",
				"Writers: decide once, after your first look at the task and its files, and never later. Start writers when the work splits into two or more parts that touch different files, can each be built and checked without the others, and are each a real job on its own (their own investigation, change and checks, not a few edits): one writer per part, started together. Give each writer its own files or directories, never ones another agent changes, and state the interfaces between the parts in the briefs. While they work, do your own part in other files; then integrate their parts and run the final checks yourself. One focused change, even across several files, or steps that depend on each other, you do yourself.",
				"A helper costs about as much as you do and re-reads what it needs; what it buys is time and a smaller context for you. Start one only for an independent investigation likely to take over 10 minutes, while you have other work to do meanwhile; when a broad investigation splits into several such areas, start one per area together. Small, quick or sequential work, or anything you would finish in a few steps, you do yourself.",
				"Every brief is self-contained: the goal, the paths and findings it needs, constraints and the report format.",
				"Keep working while helpers run. Once you have what you need, stop running helpers with agent_send instead of waiting for them.",
				"A report is a claim: spot-check it before relying on it. A refused start means do the work yourself.",
			].join("\n"),
		);
		for (const rule of [
			WRITER_DELEGATION_POLICY,
			READER_DELEGATION_POLICY,
			BRIEF_POLICY,
			KEEP_WORKING_POLICY,
			REPORT_IS_A_CLAIM,
			REFUSED_START,
		])
			expect(WRITE_HELPER_INSTRUCTIONS).toContain(rule);
		// helpers=on: the same policy without the writer rule.
		expect(HELPER_INSTRUCTIONS).toContain(READER_DELEGATION_POLICY);
		expect(HELPER_INSTRUCTIONS).not.toContain(WRITER_DELEGATION_POLICY);
		expect(WRITE_HELPER_INSTRUCTIONS.split("\n").slice(2)).toEqual(
			HELPER_INSTRUCTIONS.split("\n").slice(1),
		);
	});

	it("gives the builder the writers' section and lists writes outside owns", () => {
		expect(WRITE_HELPER_INSTRUCTIONS).toContain(
			"decide once, after your first look at the task",
		);
		expect(WRITE_HELPER_INSTRUCTIONS).toContain("and never later");
		// The read-only helpers' rules stay.
		expect(WRITE_HELPER_INSTRUCTIONS).toContain(
			"independent investigation likely to take over 10 minutes",
		);
		const event = (name: string, input: unknown) => ({
			type: "tool-call" as const,
			id: name,
			name,
			input,
		});
		expect(
			writesOutside(
				[
					event("write", { path: "src/a/x.py" }),
					event("edit", { path: "/app/src/b.py" }),
					event("run_code", {
						code: "await tools.write({ path: 'README.md', content: '' }); await tools.edit({path:\"src/a/y.py\"})",
					}),
					event("bash", { command: "echo > other.txt" }),
				],
				"/app",
				["src/a"],
			),
		).toEqual(["/app/src/b.py", "/app/README.md"]);
	});
});

describe("planTool (plan=on)", () => {
	it("keeps each full update and answers with a summary; at most one step in progress", async () => {
		const updates: unknown[] = [];
		const tools = planTool({ now: () => 0, onUpdate: (u) => updates.push(u) });
		expect(Object.keys(tools)).toEqual([PLAN_TOOL]);
		const plan = [
			{ step: "Read the spec", status: "completed" },
			{ step: "Implement", status: "in_progress" },
			{ step: "Test", status: "pending" },
		];
		expect(await run(tools, PLAN_TOOL, { explanation: "Started.", plan })).toBe(
			"Plan updated: 1 completed, 1 in progress, 1 pending.",
		);
		expect(updates).toEqual([
			{ at: "1970-01-01T00:00:00.000Z", explanation: "Started.", plan },
		]);
		expect(
			await run(tools, PLAN_TOOL, {
				plan: plan.map((entry) => ({ ...entry, status: "in_progress" })),
			}),
		).toMatch(/^Plan not updated: 3 steps are in_progress/);
		expect(updates).toHaveLength(1);
		expect(planSummary([])).toBe("0 completed, 0 in progress, 0 pending");
	});
});
