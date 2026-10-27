import { describe, expect, it } from "vitest";
import {
	AGENT_WAIT_TOOL,
	type HelperRole,
	helperTools,
	MAX_LIVE_HELPERS,
	WRITE_HELPER_INSTRUCTIONS,
	writesOutside,
} from "../evals/harbor_v2/helpers";
import type { ChildReport, ChildSession } from "../evals/harbor_v2/sessions";
import { trialSessions } from "../evals/harbor_v2/sessions";
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

	it("gives the builder the writers' section and lists writes outside owns", () => {
		expect(WRITE_HELPER_INSTRUCTIONS).toContain(
			"decide right after reading the task",
		);
		expect(WRITE_HELPER_INSTRUCTIONS).toContain("Never start a writer later");
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
