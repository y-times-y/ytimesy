/**
 * Builder subagents (docs/subagents.md, decision 2026-10-17): the builder is
 * level 0 and spawns children through one `agent` tool. Placement follows
 * role: a writer works on a fork of the parent's VM, readers share the
 * parent's VM read-only. These are the pure rules; the runtime lives in
 * src/server/services/subagent-*.ts.
 */

export const SUBAGENT_ROLES = [
	"writer",
	"researcher",
	"reviewer",
	"checker",
] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];
export type ReaderRole = Exclude<SubagentRole, "writer">;

export function isSubagentRole(value: unknown): value is SubagentRole {
	return (SUBAGENT_ROLES as readonly unknown[]).includes(value);
}

export function isReaderRole(role: SubagentRole | null | undefined) {
	return !!role && role !== "writer";
}

/** Where a child runs; not an argument, because it follows from the role. */
export type SubagentPlacement = "fork" | "shared-read-only";

export function subagentPlacement(role: SubagentRole): SubagentPlacement {
	return role === "writer" ? "fork" : "shared-read-only";
}

/** The deepest level; a child at this level cannot spawn. */
export const MAX_SUBAGENT_LEVEL = 3;
/** Agents running at once anywhere in one tree. */
export const SUBAGENT_TREE_LIVE_LIMIT = 8;
/** The tree's whole token allowance: the existing per-task api_usage_budget. */
export const SUBAGENT_TREE_TOKEN_BUDGET = 5_000_000;
export const SUBAGENT_TITLE_MAX = 80;
export const SUBAGENT_BRIEF_MAX = 12_000;

export type SubagentBudget = {
	readonly steps: number;
	readonly minutes: number;
	readonly tokens: number;
	/** Set by agent_send stop: the step count at which the turn stops. */
	readonly stopAtStep?: number;
};

type Level = 1 | 2 | 3;

/**
 * Starting values from the decision; Phase 4 tunes them from measured runs.
 * `liveChildren` is how many children an agent at that level may run at
 * once (the builder, level 0, gets level 1's four).
 */
export const SUBAGENT_LEVEL_LIMITS: Record<
	Level,
	SubagentBudget & { readonly liveChildren: number }
> = {
	1: { steps: 150, minutes: 30, tokens: 2_000_000, liveChildren: 4 },
	2: { steps: 75, minutes: 15, tokens: 1_000_000, liveChildren: 2 },
	3: { steps: 40, minutes: 8, tokens: 500_000, liveChildren: 0 },
};

/** Live children a parent at `level` may have (the builder is level 0). */
export function liveChildrenAllowed(level: number) {
	if (level <= 0) return SUBAGENT_LEVEL_LIMITS[1].liveChildren;
	return level >= MAX_SUBAGENT_LEVEL
		? 0
		: SUBAGENT_LEVEL_LIMITS[level as Level].liveChildren;
}

/** What is left of a budget; the builder's own steps and minutes are unbounded here. */
export type SubagentRemaining = SubagentBudget;

export type SubagentUsed = {
	readonly steps: number;
	readonly minutes: number;
	/** The node's own tokens plus every descendant's: tree tokens are summed. */
	readonly tokens: number;
};

export function subagentRemaining(
	budget: SubagentBudget,
	used: SubagentUsed,
): SubagentRemaining {
	return {
		steps: Math.max(0, budget.steps - used.steps),
		minutes: Math.max(0, budget.minutes - used.minutes),
		tokens: Math.max(0, budget.tokens - used.tokens),
	};
}

/** The builder's remaining budget: the tree's token allowance, no step or time cap of its own. */
export function builderRemaining(treeTokens: number): SubagentRemaining {
	return {
		steps: Number.POSITIVE_INFINITY,
		minutes: Number.POSITIVE_INFINITY,
		tokens: Math.max(0, SUBAGENT_TREE_TOKEN_BUDGET - treeTokens),
	};
}

/** Below these a child cannot do useful work, so the spawn is refused instead. */
const MINIMUM_BUDGET: SubagentBudget = { steps: 5, minutes: 1, tokens: 50_000 };

/**
 * A new child's budget at `level`: the level's limits, each capped at half of
 * what the parent has left. Null when that leaves too little to be useful.
 */
export function childSubagentBudget(
	level: number,
	parentRemaining: SubagentRemaining,
): SubagentBudget | null {
	if (level < 1 || level > MAX_SUBAGENT_LEVEL) return null;
	const limits = SUBAGENT_LEVEL_LIMITS[level as Level];
	const half = (value: number) =>
		Number.isFinite(value) ? Math.floor(value / 2) : value;
	const budget = {
		steps: Math.min(limits.steps, half(parentRemaining.steps)),
		minutes: Math.min(limits.minutes, half(parentRemaining.minutes)),
		tokens: Math.min(limits.tokens, half(parentRemaining.tokens)),
	};
	return budget.steps >= MINIMUM_BUDGET.steps &&
		budget.minutes >= MINIMUM_BUDGET.minutes &&
		budget.tokens >= MINIMUM_BUDGET.tokens
		? budget
		: null;
}

export type SubagentBudgetState =
	| { readonly state: "ok" }
	| { readonly state: "wrap-up" | "exhausted"; readonly reason: string };

/** At 90% of any dimension the child is told to wrap up; at 100% its turn stops. */
export function subagentBudgetState(
	budget: SubagentBudget,
	used: SubagentUsed,
): SubagentBudgetState {
	const dimensions: [string, number, number][] = [
		["steps", used.steps, budget.steps],
		["minutes", used.minutes, budget.minutes],
		["tokens", used.tokens, budget.tokens],
	];
	const describe = ([name, value, limit]: [string, number, number]) =>
		`${name} ${Math.round(value).toLocaleString("en-US")}/${limit.toLocaleString("en-US")}`;
	if (budget.stopAtStep !== undefined) {
		if (used.steps >= budget.stopAtStep)
			return { state: "exhausted", reason: "stopped by the parent" };
		return { state: "wrap-up", reason: "the parent asked you to stop" };
	}
	const exhausted = dimensions.find(([, value, limit]) => value >= limit);
	if (exhausted) return { state: "exhausted", reason: describe(exhausted) };
	const near = dimensions.find(([, value, limit]) => value >= limit * 0.9);
	return near ? { state: "wrap-up", reason: describe(near) } : { state: "ok" };
}

export type SubagentAdmissionInput = {
	/** The spawning agent's level; the builder is 0. */
	readonly parentLevel: number;
	readonly liveChildrenOfParent: number;
	readonly liveInTree: number;
	readonly parentRemaining: SubagentRemaining;
};

export type SubagentAdmission =
	| {
			readonly admitted: true;
			readonly level: number;
			readonly budget: SubagentBudget;
	  }
	| { readonly admitted: false; readonly reason: string };

/**
 * Depth, concurrency and budget, checked before anything is created. A
 * refusal tells the builder to do the work itself.
 */
export function subagentAdmission(
	input: SubagentAdmissionInput,
): SubagentAdmission {
	const level = input.parentLevel + 1;
	const refuse = (reason: string): SubagentAdmission => ({
		admitted: false,
		reason: `${reason} Do this work yourself.`,
	});
	if (level > MAX_SUBAGENT_LEVEL)
		return refuse(`Agents at level ${MAX_SUBAGENT_LEVEL} cannot spawn.`);
	const allowed = liveChildrenAllowed(input.parentLevel);
	if (input.liveChildrenOfParent >= allowed)
		return refuse(
			`You already have ${input.liveChildrenOfParent} running agents (at most ${allowed}).`,
		);
	if (input.liveInTree >= SUBAGENT_TREE_LIVE_LIMIT)
		return refuse(
			`This task already runs ${SUBAGENT_TREE_LIVE_LIMIT} agents, the most one task may run at once.`,
		);
	const budget = childSubagentBudget(level, input.parentRemaining);
	if (!budget) return refuse("Too little budget is left for another agent.");
	return { admitted: true, level, budget };
}

/** Positional ids: 1, 1.2, 1.2.1 (the decision's "id"). */
export function subagentLabelFromTaskLabel(label: string) {
	return label.replace(/^Task\s+/, "");
}

export function subagentLevelFromLabel(label: string) {
	return label.split(".").length;
}

export type SubagentOutcome = "finished" | "failed" | "budget exhausted";

export function subagentReportHeader(input: {
	readonly label: string;
	readonly role: SubagentRole;
	readonly outcome: SubagentOutcome;
	readonly steps: number;
	readonly minutes: number;
	readonly tokens: number;
	readonly costUsd?: number | null;
	/** costUsd is a list-price estimate for a plan-billed route. */
	readonly costEstimated?: boolean;
}) {
	const tokens =
		input.tokens >= 1_000_000
			? `${(input.tokens / 1_000_000).toFixed(1)}M`
			: `${Math.round(input.tokens / 1000)}k`;
	const cost =
		input.costUsd === null || input.costUsd === undefined
			? ""
			: input.costEstimated
				? ` · ~$${input.costUsd.toFixed(2)} list-price est.`
				: ` · $${input.costUsd.toFixed(2)}`;
	return `[agent ${input.label} ${input.role} ${input.outcome} · ${input.steps} steps · ${Math.max(0, Math.round(input.minutes))}m · ${tokens} tokens${cost}]`;
}

export type WriterPatch = {
	/** Where the patch lies in the parent's VM. */
	readonly path: string;
	readonly files: readonly string[];
	readonly added: number;
	readonly removed: number;
	readonly sha256: string;
	readonly ref: string;
	readonly base: string;
};

export function writerPatchRef(label: string) {
	return `refs/ytimesy/agents/${label}`;
}

export function writerPatchPath(label: string) {
	return `~/.ytimesy/agents/${label}.patch`;
}

/** Siblings' writers that touched the same files, so the parent hears before it applies. */
export function overlappingWriters(
	files: readonly string[],
	siblings: readonly {
		readonly label: string;
		readonly files: readonly string[];
	}[],
) {
	const own = new Set(files);
	return siblings.flatMap((sibling) => {
		const shared = sibling.files.filter((file) => own.has(file));
		return shared.length ? [{ label: sibling.label, files: shared }] : [];
	});
}

export function writerPatchBlock(
	patch: WriterPatch | null,
	overlaps: ReturnType<typeof overlappingWriters>,
	failure?: string,
) {
	if (!patch)
		return failure
			? `Patch: not transferred (${failure}).`
			: "Patch: no changes.";
	return [
		`Patch: ${patch.path} (${patch.files.length} files, +${patch.added} −${patch.removed}, sha256 ${patch.sha256.slice(0, 16)})`,
		`Ref:   ${patch.ref}   Base: ${patch.base}`,
		...(overlaps.length
			? [
					`Overlaps with: ${overlaps.map((overlap) => `agent ${overlap.label} (${overlap.files.slice(0, 4).join(", ")}${overlap.files.length > 4 ? ", …" : ""})`).join("; ")}`,
				]
			: []),
		`Review with \`git diff ${patch.base} ${patch.ref}\`; apply with \`git apply -3 ${patch.path}\` (or merge the ref).`,
	].join("\n");
}

/**
 * The checker's whole brief, built by the runtime: the user's task verbatim
 * and the deliverable. The builder cannot add hints, so the verdict is
 * independent of the builder's own reading of the task.
 */
export function checkerBrief(input: {
	readonly taskText: string;
	readonly checkout: string;
	readonly changedFiles: readonly string[];
	readonly scratch: string;
}) {
	return [
		"You are an independent checker. Decide whether the deliverable below meets the task. You did not build it and nobody will tell you what to look for.",
		"",
		"<task>",
		input.taskText,
		"</task>",
		"",
		"<deliverable>",
		`The working tree at ${input.checkout}${input.changedFiles.length ? `, changed files: ${input.changedFiles.slice(0, 200).join(", ")}` : " (no uncommitted changes)"}.`,
		"</deliverable>",
		"",
		`The checkout is read-only for you. Copy it first (\`cp -a ${input.checkout} ${input.scratch}/work\`) and work only in ${input.scratch}. Write your own acceptance tests from the task text, run them and \`ytimesy-check\` where it applies, then answer with only this JSON:`,
		'{ "verdict": "pass" | "fail" | "unsure", "tests": [{ "name": "...", "passed": true, "evidence": "..." }], "notes": "..." }',
	].join("\n");
}

/** The builder's delegation tools (loaded on demand through find_tools). */
export const AGENT_TOOL = "agent";
export const AGENT_SEND_TOOL = "agent_send";

/** A writer's forked VM, as recorded on its session (agent_fork). */
export type SubagentFork = {
	readonly vmId: string;
	readonly sourceVmId: string;
	/** Milliseconds from snapshot start to the fork VM running. */
	readonly forkMs?: number;
	readonly bootedAt: string;
	/** The fork's first commit: the parent's working tree at fork time. */
	readonly base?: string;
	/** The parent's HEAD when the fork was taken (the bundle's boundary). */
	readonly parentHead?: string;
	readonly patch?: WriterPatch | null;
	readonly reportedAt?: string;
	readonly deletedAt?: string;
};
