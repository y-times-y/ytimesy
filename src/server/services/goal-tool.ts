import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { claimGoal, type Goal, goalSummary } from "../../domain/goal";

export const GOAL_TOOL = "goal";

const evidence = z.object({
	requirement: z
		.string()
		.min(1)
		.describe("The requirement, in the request's own words"),
	proof: z
		.string()
		.min(1)
		.describe(
			"The command you ran on the final deliverable and the result you observed",
		),
});

const goalInput = z.object({
	op: z
		.enum(["get", "update"])
		.describe("get returns the goal; update marks it complete or blocked"),
	status: z
		.enum(["complete", "blocked"])
		.optional()
		.describe(
			"op update: complete when every requirement is proven on the final deliverable; blocked only when the same blocker has stopped you for three turns and needs outside input",
		),
	evidence: z
		.array(evidence)
		.optional()
		.describe("op update: one entry per requirement (required for complete)"),
	reason: z
		.string()
		.optional()
		.describe("op update: why it is blocked (required for blocked)"),
});

/**
 * The agent's goal tool over a goal the harness holds (src/domain/goal.ts):
 * read it back, or mark it complete with evidence or blocked with a reason.
 * `state.goal` is replaced on an accepted update.
 */
export function goalTool(input: {
	state: { goal: Goal };
	now: () => number;
	/** An accepted update, for the caller's log and trace. */
	onUpdate?: (goal: Goal) => void;
}): ToolSet {
	return {
		[GOAL_TOOL]: tool({
			description:
				'The run\'s goal, held by the harness: op "get" reads it; op "update" marks it complete (with one evidence entry per requirement: its words from the request, and the command run on the final deliverable with its observed result) or blocked (with the reason). The run continues until the goal is complete or blocked. Do not mark it complete because time is short or you are stopping; mark it complete only when the evidence proves every requirement.',
			inputSchema: goalInput,
			execute: async (args) => {
				const { state } = input;
				if (args.op === "get") return goalSummary(state.goal);
				if (!args.status)
					return 'Nothing changed: op "update" takes status "complete" or "blocked".';
				const result = claimGoal(
					state.goal,
					{
						status: args.status,
						evidence: args.evidence ?? [],
						...(args.reason ? { reason: args.reason } : {}),
					},
					input.now(),
				);
				if (!result.ok) return result.error;
				state.goal = result.goal;
				input.onUpdate?.(result.goal);
				const unquoted = result.goal.claim?.unquoted ?? 0;
				return [
					`Goal marked ${args.status}.`,
					...(unquoted
						? [
								`${unquoted} evidence ${unquoted === 1 ? "entry does" : "entries do"} not quote the request word for word.`,
							]
						: []),
				].join(" ");
			},
		}),
	};
}
