import { type ModelMessage, tool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { endedByTool } from "./model-agent-loop";
import {
	PLAN_END_TURN_TOOLS,
	PLAN_REVISION_NOTICE,
	PlanLock,
	planTools,
	withPlanMode,
	withPlanModeNotice,
} from "./plan-mode";

const options = {
	toolCallId: "c",
	messages: [],
	abortSignal: new AbortController().signal,
	context: {},
};

const make = (ran: () => Promise<unknown>) =>
	tool({ inputSchema: z.object({}).passthrough(), execute: ran });

it("refuses the builder's edits and shell writes, but still runs reading commands", async () => {
	const ran = vi.fn(async () => ({ ok: true }));
	const tools = withPlanMode({
		apply_patch: make(ran),
		apply_patches: make(ran),
		replace_text: make(ran),
		rename_symbol: make(ran),
		execute_command: make(ran),
		view_image: make(ran),
	});
	for (const name of [
		"apply_patch",
		"apply_patches",
		"replace_text",
		"rename_symbol",
	])
		expect(await tools[name].execute?.({}, options)).toMatchObject({
			blocked: true,
		});
	expect(
		await tools.execute_command.execute?.(
			{ command: "cat > src/app.ts <<'EOF'\nexport {}\nEOF" },
			options,
		),
	).toMatchObject({ blocked: true });
	expect(ran).not.toHaveBeenCalled();
	await tools.execute_command.execute?.(
		{ command: "rg -n login src" },
		options,
	);
	await tools.view_image.execute?.({}, options);
	expect(ran).toHaveBeenCalledTimes(2);
});

it("locks edits only once the agent enters plan mode, mid-turn", async () => {
	const ran = vi.fn(async () => ({ ok: true }));
	const lock = new PlanLock({ kind: "none" });
	const tools = withPlanMode(
		{ apply_patch: make(ran), ...planTools(lock) },
		() => lock.planning,
	);
	await tools.apply_patch.execute?.({}, options);
	expect(ran).toHaveBeenCalledTimes(1);
	await tools.enter_plan_mode.execute?.(
		{ reason: "Schema migration" },
		options,
	);
	expect(await tools.apply_patch.execute?.({}, options)).toMatchObject({
		blocked: true,
	});
	expect(ran).toHaveBeenCalledTimes(1);
	const proposed = await tools.propose_plan.execute?.(
		{ plan: "1. Migrate" },
		options,
	);
	// The transcript reads the accepted plan from the result; the model is not sent it again.
	expect(proposed).toMatchObject({ proposed: true, plan: "1. Migrate" });
	expect(
		await tools.propose_plan.toModelOutput?.({
			toolCallId: "c",
			input: { plan: "1. Migrate" },
			output: proposed,
		}),
	).toEqual({ type: "json", value: { proposed: true, next: proposed.next } });
});

it("starts locked when the transcript says a plan is in progress", () => {
	expect(new PlanLock({ kind: "planning" }).planning).toBe(true);
	expect(
		new PlanLock({ kind: "proposed", planId: "t:p" as never }).planning,
	).toBe(true);
	expect(new PlanLock({ kind: "none" }).planning).toBe(false);
});

it("adds a notice once per turn, and again on a later turn", () => {
	const once = withPlanModeNotice(
		[{ role: "user", content: "Fix login" }],
		PLAN_REVISION_NOTICE,
	);
	expect(once.at(-1)).toEqual({ role: "user", content: PLAN_REVISION_NOTICE });
	expect(withPlanModeNotice(once, PLAN_REVISION_NOTICE)).toHaveLength(2);
	const later: ModelMessage[] = [
		...once,
		{ role: "assistant", content: "Revised." },
		{ role: "user", content: "Smaller please" },
	];
	expect(withPlanModeNotice(later, PLAN_REVISION_NOTICE)).toHaveLength(5);
});

it("ends the turn only after a successful propose_plan", () => {
	const call: ModelMessage = {
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "1",
				toolName: "propose_plan",
				input: { plan: "1." },
			},
		],
	};
	const result = (type: "json" | "error-text"): ModelMessage => ({
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "1",
				toolName: "propose_plan",
				output:
					type === "json"
						? { type, value: { proposed: true } }
						: { type, value: "bad input" },
			},
		],
	});
	expect(endedByTool([call, result("json")], PLAN_END_TURN_TOOLS)).toBe(true);
	// Notices injected after the tool results do not hide it.
	expect(
		endedByTool(
			[call, result("json"), { role: "user", content: "notice" }],
			PLAN_END_TURN_TOOLS,
		),
	).toBe(true);
	expect(endedByTool([call, result("error-text")], PLAN_END_TURN_TOOLS)).toBe(
		false,
	);
	expect(endedByTool([call, result("json")], undefined)).toBe(false);
	expect(
		endedByTool(
			[call, result("json"), { role: "assistant", content: "Done" }],
			PLAN_END_TURN_TOOLS,
		),
	).toBe(false);
});

it("refuses the lean surfaces' edit tools and shell writes in every family's argument name", async () => {
	const ran = vi.fn(async () => ({ ok: true }));
	const names = ["Write", "Edit", "write_file", "replace", "edit", "write"];
	const tools = withPlanMode(
		Object.fromEntries(
			[
				...names,
				"exec_command",
				"Bash",
				"run_shell_command",
				"bash",
				"Read",
			].map((name) => [name, make(ran)]),
		),
	);
	for (const name of names)
		expect(await tools[name].execute?.({}, options)).toMatchObject({
			blocked: true,
		});
	expect(
		await tools.exec_command.execute?.(
			{ cmd: "cat > src/app.ts <<'EOF'\nexport {}\nEOF" },
			options,
		),
	).toMatchObject({ blocked: true });
	for (const name of ["Bash", "run_shell_command", "bash"])
		expect(
			await tools[name].execute?.(
				{ command: "cat > src/b.ts <<'EOF'\nexport {}\nEOF" },
				options,
			),
		).toMatchObject({ blocked: true });
	await tools.Bash.execute?.({ command: "rg -n foo src" }, options);
	await tools.exec_command.execute?.({ cmd: "git status" }, options);
	await tools.Read.execute?.({ file_path: "a.txt" }, options);
	expect(ran).toHaveBeenCalledTimes(3);
});
