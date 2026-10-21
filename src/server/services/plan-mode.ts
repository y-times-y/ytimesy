import { type JSONValue, type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	type AgentPlanState,
	ENTER_PLAN_MODE_TOOL,
	EXIT_PLAN_MODE_TOOL,
	PLAN_TEXT_LIMIT,
	PROPOSE_PLAN_TOOL,
} from "#/domain/agent-plan";
import {
	LEAN_COMMAND_ARGUMENTS,
	leanToolNames,
} from "#/domain/harness-model-profile";
import { fileChangesFromShellCommand } from "#/domain/shell-file-change";

/** Tools whose successful call ends the turn. */
export const PLAN_END_TURN_TOOLS = [PROPOSE_PLAN_TOOL] as const;

export const PLAN_REVISION_NOTICE =
	'Plan mode: the user replied to your proposed plan. If the reply approves it (for example "yes", "go ahead", "looks good, build it"), call exit_plan_mode, then implement the plan, applying any small adjustments the reply asks for. If it asks for changes, raises questions, or asks for something else, it is not approval: investigate read-only if needed and call propose_plan with the revised plan. When unsure, ask the user in plain words instead of guessing. File edits stay refused until you call exit_plan_mode.';

export const PLAN_CONTINUE_NOTICE =
	"Plan mode is still on: investigate read-only and finish with propose_plan. File edits stay refused until the user approves.";

/** The builder edits its own checkout, so plan mode refuses its editing tools too. */
const EDITING_TOOLS = new Set([
	"apply_patch",
	"apply_patches",
	"replace_text",
	"rename_symbol",
	// Lean surfaces' editing tools.
	...leanToolNames(["write", "edit"]),
]);

/** Command tools whose shell text may write files, and the argument holding it. */
const COMMAND_TOOLS: Readonly<Record<string, string>> = {
	execute_command: "command",
	bash: "command",
	...LEAN_COMMAND_ARGUMENTS,
};

const REFUSAL = {
	blocked: true,
	error:
		"Plan mode: implementation is paused until the user approves the plan. Investigate read-only and call propose_plan; once the user's reply approves it, call exit_plan_mode.",
};

/** Tools that would edit files; read-only helpers stay available. */
function startsWritingWork(name: string, args: unknown) {
	if (EDITING_TOOLS.has(name)) return true;
	if (name in COMMAND_TOOLS) {
		// Best effort: shell writes the transcript would show as file changes.
		const command = (args as Record<string, unknown> | null)?.[
			COMMAND_TOOLS[name]
		];
		return (
			typeof command === "string" &&
			fileChangesFromShellCommand(command).length > 0
		);
	}
	return false;
}

/**
 * Enforces plan mode server-side while `planning()` is true; prompts alone
 * cannot be trusted to stop a writer. Checked per call, so entering plan mode
 * mid-turn locks the rest of the turn.
 */
export function withPlanMode(
	tools: ToolSet,
	planning: () => boolean = () => true,
): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, definition]) => {
			const execute = definition.execute;
			if (!execute) return [name, definition];
			return [
				name,
				{
					...definition,
					execute: (
						args: unknown,
						options: Parameters<NonNullable<typeof execute>>[1],
					) =>
						planning() && startsWritingWork(name, args)
							? Promise.resolve(REFUSAL)
							: execute(args as never, options),
				},
			];
		}),
	) as ToolSet;
}

/** The turn's plan lock: starts from the transcript; the plan tools turn it on and off. */
export class PlanLock {
	#planning: boolean;
	/** A plan was proposed before this turn, so the user's message is its answer. */
	#answering: boolean;
	constructor(state: AgentPlanState) {
		this.#planning = state.kind !== "none";
		this.#answering = state.kind === "proposed";
	}
	get planning() {
		return this.#planning;
	}
	/** exit_plan_mode is allowed only while answering a plan proposed in an earlier turn. */
	get canExit() {
		return this.#planning && this.#answering;
	}
	enter() {
		this.#planning = true;
	}
	propose() {
		this.#planning = true;
		// A plan proposed this turn has no answer yet.
		this.#answering = false;
	}
	exit() {
		this.#planning = false;
		this.#answering = false;
	}
}

/** The agent decides when a request needs a plan approved before any edits. */
export function planTools(lock: PlanLock): ToolSet {
	return {
		[ENTER_PLAN_MODE_TOOL]: tool({
			description:
				"Enter plan mode before changing anything when the request is large, ambiguous or risky: many files or subsystems, unclear requirements, schema or data migrations, deletions, public API changes, or several reasonable approaches the user should choose between. Do not use it for small, clear tasks; just do those. After entering, file edits are refused: investigate read-only, then call propose_plan.",
			inputSchema: z.object({
				reason: z
					.string()
					.max(300)
					.describe("One sentence: why this needs the user's approval first."),
			}),
			execute: async () => {
				lock.enter();
				return {
					planMode: true,
					next: "Investigate read-only, then call propose_plan. Edits are refused until the user approves.",
				};
			},
		}),
		[PROPOSE_PLAN_TOOL]: tool({
			description:
				"Submit your plan for the user's approval and end this turn. The user reads it as your chat message and answers in words: approval (you call exit_plan_mode and implement it) or feedback (revise and propose again). Write Markdown: the goal, the approach, the files to change, risks and open questions, and the checks that will prove it works. Do not repeat the plan in a message.",
			inputSchema: z.object({
				plan: z.string().min(1).max(PLAN_TEXT_LIMIT),
			}),
			execute: async ({ plan }) => {
				lock.propose();
				return {
					proposed: true,
					// The transcript records the plan from this result, so a call
					// that failed validation or was refused never shows as proposed.
					plan,
					next: "Stop here. The user will approve or reply with feedback.",
				};
			},
			// The model already wrote the plan; it does not need it echoed back.
			toModelOutput: ({ output }) => {
				const { plan: _plan, ...rest } = output as Record<string, unknown>;
				return { type: "json", value: rest as JSONValue };
			},
		}),
		[EXIT_PLAN_MODE_TOOL]: tool({
			description:
				'Leave plan mode and unlock file edits. Call it only when the user\'s latest message approves the plan you proposed ("yes", "go ahead", "looks good, build it"), then implement that plan. Never call it on feedback, questions or a different request: revise with propose_plan instead.',
			inputSchema: z.object({
				approval: z
					.string()
					.max(300)
					.describe("The words of the user's reply that approve the plan."),
			}),
			execute: async () => {
				if (!lock.canExit)
					return {
						blocked: true,
						error:
							"No proposed plan is waiting for the user's answer: propose_plan first, and leave plan mode only after the user approves it in their next message.",
					};
				lock.exit();
				return {
					planMode: false,
					next: "Edits are unlocked. Implement the approved plan now.",
				};
			},
		}),
	};
}

/**
 * Adds a notice after the user's message, so the cached prefix is kept. Once
 * per turn: a notice already among the trailing user messages is not repeated.
 */
export function withPlanModeNotice(
	messages: ModelMessage[],
	notice: string,
): ModelMessage[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") break;
		if (message.content === notice) return messages;
	}
	return [...messages, { role: "user", content: notice }];
}
