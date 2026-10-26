/**
 * Goal mode (harness variant goal=on; later the product's long-running
 * goals): the harness holds a goal outside the transcript, so compaction
 * cannot drop it, and keeps sending the agent back while it is active. Only
 * the working model marks it done, through the goal tool: complete with
 * evidence, or blocked. Every other stop is deterministic and the
 * harness's: the deadline, a run of continuations with no tool call, or the
 * continuation cap. Adapted from Codex's thread goals (its continuation
 * template, without elapsed time: it made the model shortcut work). All
 * text is generic: it names no task, check or known failure.
 */

export type GoalStatus = "active" | "complete" | "blocked" | "budget_limited";

/** One requirement and what proves it on the final deliverable. */
export type GoalEvidence = {
	/** The request's own words. */
	readonly requirement: string;
	/** The command run on the final deliverable and its observed result. */
	readonly proof: string;
};

export type GoalClaim = {
	readonly status: "complete" | "blocked";
	readonly evidence: readonly GoalEvidence[];
	readonly reason: string | null;
	readonly at: string;
	/** Evidence entries whose requirement is not found word for word in the objective. */
	readonly unquoted: number;
};

export type GoalStopReason =
	| "complete"
	| "blocked"
	| "deadline"
	| "no-progress"
	| "max-continuations";

export type Goal = {
	readonly objective: string;
	readonly status: GoalStatus;
	/** Wall clock (epoch ms) the run ends at; null = no deadline. */
	readonly deadlineAtMs: number | null;
	/** Continuations sent (the wrap-up line is not one). */
	readonly continuations: number;
	/** Consecutive continuation turns with no tool call. */
	readonly idleStreak: number;
	readonly claim: GoalClaim | null;
	/** Set once, when the loop stops. */
	readonly stopReason: GoalStopReason | null;
};

/** Continuations per goal at most. */
export const GOAL_MAX_CONTINUATIONS = 6;
/** Consecutive continuation turns without a tool call that stop the loop. */
export const GOAL_MAX_IDLE_TURNS = 3;
/** With less than this left the agent gets one wrap-up line instead of a continuation. */
export const GOAL_WRAP_UP_MS = 5 * 60_000;
/** With less than this left not even the wrap-up line is sent. */
export const GOAL_MIN_WRAP_UP_MS = 60_000;
/** Characters of the objective a continuation repeats (the full request stays in the conversation). */
export const GOAL_OBJECTIVE_MAX_CHARS = 8_000;

export function newGoal(input: {
	objective: string;
	deadlineAtMs: number | null;
}): Goal {
	return {
		objective: input.objective,
		status: "active",
		deadlineAtMs: input.deadlineAtMs,
		continuations: 0,
		idleStreak: 0,
		claim: null,
		stopReason: null,
	};
}

const normalize = (text: string) =>
	text.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The model's goal update. Only an active goal changes; complete needs at
 * least one evidence entry, blocked a reason. The model can never resume,
 * extend or budget-limit a goal.
 */
export function claimGoal(
	goal: Goal,
	claim: {
		status: "complete" | "blocked";
		evidence: readonly GoalEvidence[];
		reason?: string;
	},
	nowMs: number,
): { ok: true; goal: Goal } | { ok: false; error: string } {
	if (goal.status !== "active")
		return { ok: false, error: `The goal is already ${goal.status}.` };
	const evidence = claim.evidence.filter(
		(entry) => entry.requirement.trim() && entry.proof.trim(),
	);
	const reason = claim.reason?.trim() || null;
	if (claim.status === "complete" && !evidence.length)
		return {
			ok: false,
			error:
				"Not marked complete: give one evidence entry per requirement (the request's words, and the command you ran on the final deliverable with what it showed).",
		};
	if (claim.status === "blocked" && !reason)
		return {
			ok: false,
			error: "Not marked blocked: give the reason (the blocker you hit).",
		};
	const objective = normalize(goal.objective);
	return {
		ok: true,
		goal: {
			...goal,
			status: claim.status,
			claim: {
				status: claim.status,
				evidence,
				reason,
				at: new Date(nowMs).toISOString(),
				unquoted: evidence.filter(
					(entry) => !objective.includes(normalize(entry.requirement)),
				).length,
			},
		},
	};
}

export type GoalStep =
	/** Send `text` back as a continuation (number `round`). */
	| { readonly kind: "continue"; readonly round: number; readonly text: string }
	/** Time is nearly up: send `text` once; the goal has stopped. */
	| {
			readonly kind: "wrapUp";
			readonly reason: "deadline";
			readonly text: string;
	  }
	/** The goal stopped now, for `reason`. */
	| { readonly kind: "stop"; readonly reason: GoalStopReason }
	/** It had stopped before: nothing to send or log. */
	| { readonly kind: "stopped" };

/**
 * What follows an agent run that ended with the goal as `goal`.
 * `toolCalls`: tool calls since the last continuation was sent, or null
 * after the first run (no continuation yet).
 */
export function nextGoalStep(
	goal: Goal,
	input: { nowMs: number; toolCalls: number | null },
): { goal: Goal; step: GoalStep } {
	if (goal.stopReason) return { goal, step: { kind: "stopped" } };
	const stop = (
		reason: GoalStopReason,
		status: GoalStatus = goal.status,
		extra: Partial<Goal> = {},
	) => ({
		goal: { ...goal, ...extra, status, stopReason: reason },
		step: { kind: "stop" as const, reason },
	});
	if (goal.status === "complete") return stop("complete");
	if (goal.status === "blocked") return stop("blocked");
	if (goal.status === "budget_limited") return stop("deadline");
	const idleStreak =
		input.toolCalls === null
			? goal.idleStreak
			: input.toolCalls === 0
				? goal.idleStreak + 1
				: 0;
	if (idleStreak >= GOAL_MAX_IDLE_TURNS)
		return stop("no-progress", "blocked", { idleStreak });
	const remaining =
		goal.deadlineAtMs === null
			? Number.POSITIVE_INFINITY
			: goal.deadlineAtMs - input.nowMs;
	if (remaining < GOAL_WRAP_UP_MS) {
		if (remaining < GOAL_MIN_WRAP_UP_MS)
			return stop("deadline", "budget_limited", { idleStreak });
		return {
			goal: {
				...goal,
				idleStreak,
				status: "budget_limited",
				stopReason: "deadline",
			},
			step: { kind: "wrapUp", reason: "deadline", text: GOAL_WRAP_UP_NOTICE },
		};
	}
	if (goal.continuations >= GOAL_MAX_CONTINUATIONS)
		return stop("max-continuations", "budget_limited", { idleStreak });
	const round = goal.continuations + 1;
	return {
		goal: { ...goal, idleStreak, continuations: round },
		step: { kind: "continue", round, text: goalContinuation(goal.objective) },
	};
}

/** The objective as a tagged block: capped, and unable to close its own tag. */
function objectiveBlock(objective: string) {
	const capped =
		objective.length > GOAL_OBJECTIVE_MAX_CHARS
			? `${objective.slice(0, GOAL_OBJECTIVE_MAX_CHARS)}\n[... cut; the full request is earlier in this conversation]`
			: objective;
	return `<objective>\n${capped.replaceAll("</objective>", "<\\/objective>")}\n</objective>`;
}

/** The note after the request on the first message. */
export const GOAL_RUN_NOTE =
	'Harness note: the request above is this run\'s goal. The run continues until you mark it complete with evidence (goal tool, op "update", status "complete") or blocked.';

export function withGoalNote(message: string) {
	return `${message}\n\n${GOAL_RUN_NOTE}`;
}

/** The continuation sent while the goal is active (a user-role runtime notice). */
export function goalContinuation(objective: string) {
	return [
		"Runtime notice, not a new user request. The goal below is still active; the run continues until you mark it complete with evidence, or blocked.",
		objectiveBlock(objective),
		"- Keep the whole objective. Do not narrow it to a smaller, easier or merely test-passing version; improve, replace or remove earlier work that does not serve the requested end state.",
		"- Treat the current files and command output as the truth; re-check what you remember before relying on it.",
		"- If your last turn changed nothing and gave no new evidence, take the next concrete action now.",
		'- Audit before claiming completion: list every requirement in the objective and in the files it points to, and for each run a command on the final deliverable and read the result. A proxy signal such as "tests pass" or "it builds" is proof only if it covers that requirement; a narrow check does not prove a broad claim; missing, indirect or uncertain evidence means not done.',
		'- Then keep working, or call the goal tool (op "update"): status "complete" with one evidence entry per requirement (its words from the request, the command and what it showed), or "blocked" with the reason, only when the same blocker has stopped you for three turns and needs outside input, never because the work is hard.',
	].join("\n");
}

/** The one line sent instead of a continuation when time is nearly up. */
export const GOAL_WRAP_UP_NOTICE =
	"Runtime notice, not a new user request. Time is nearly up: start no new work, leave the deliverable in a working state, and finish with a brief summary of what is done and what remains.";

/** What follows a compaction while the goal is active: the objective again. */
export function goalCompactionNote(goal: Goal) {
	return goal.status === "active"
		? `Goal (active; the run continues until you mark it complete with evidence, or blocked):\n${objectiveBlock(goal.objective)}`
		: null;
}

/** The goal tool's `get` result. */
export function goalSummary(goal: Goal) {
	return JSON.stringify(
		{
			objective: goal.objective,
			status: goal.status,
			continuations: goal.continuations,
			...(goal.claim ? { claim: goal.claim } : {}),
		},
		null,
		2,
	);
}
