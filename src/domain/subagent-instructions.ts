import type { FusionPairProfile } from "./fusion-pairs";
import {
	AGENT_SEND_TOOL,
	AGENT_TOOL,
	type SubagentBudget,
	type SubagentRole,
} from "./subagent";

/**
 * The orchestration block (subagents=on): when to delegate, how to call
 * the agent tool, how to brief, coordinate and verify. Shown to every agent
 * that has the agent tool (never a checker). agent and agent_send are
 * ordinary tools in the tool list, so their arguments come from their
 * schemas; this block says when and how to use them.
 */
export function orchestratorInstructions(
	options: {
		codeMode?: boolean | "primary";
		/** A read-only subagent: it may start readers, never writers. */
		readOnly?: boolean;
		/** Harness variant subagents=force (the root builder only). */
		force?: boolean;
	} = {},
) {
	const { codeMode, readOnly, force } = options;
	const parallel = readOnly
		? 'await Promise.all([tools.agent({ role: "researcher", title: "Map the parser", brief: "…" }), tools.agent({ role: "researcher", title: "Map the cache", brief: "…" })])'
		: 'await Promise.all([tools.agent({ role: "writer", title: "Fix pricing rounding", brief: "…" }), tools.agent({ role: "writer", title: "Build the release bundle", brief: "…" })])';
	const howParallel = codeMode
		? `start them together from one run_code program: ${parallel}`
		: "start them together: call agent once per part in the same step";
	return [
		`Subagents: \`agent\` starts a background agent with only your brief and returns its id at once; \`agent_send\` steers or stops one. Their reports arrive as messages.${readOnly ? " You may start only researchers, reviewers and checkers." : ""}`,
		"Delegate when it saves wall-clock time:",
		readOnly
			? `- two or more independent investigations, each likely to take over 5 minutes: ${howParallel};`
			: `- two or more independent parts, each likely to take over 5 minutes, or a long build or test run beside a fix: start writers in parallel; ${howParallel};`,
		readOnly
			? "- a fresh context: a long investigation whose findings you need, not its trail."
			: "- after a hard fix, a reviewer can check it while you run the suite yourself;",
		...(readOnly
			? []
			: [
					"- isolation: a risky or exploratory change on a writer's fork, away from your working tree.",
				]),
		"Every agent re-reads the code it needs and spends its own tokens: small, quick or sequential work, or anything you would finish in a few steps, you do yourself.",
		readOnly
			? "Roles: researcher and reviewer read your VM and cannot change it; checker gets only the user's task and the current work and returns pass, fail or unsure."
			: "Roles: writer edits on a fork of your VM (your uncommitted work included) and returns a patch and git ref; researcher and reviewer read your VM and cannot change it; checker gets only the user's task and your current work and returns pass, fail or unsure.",
		`Every brief is self-contained: the goal; the context it needs (paths, findings, commands that work); constraints; what not to touch (files owned by others, shared ports, the dev server); and the report format.${readOnly ? "" : " Writers report what changed, how it was verified and what is unverified."}`,
		...(readOnly
			? []
			: [
					"Coordinate shared resources: give each writer a disjoint file set and each process its own port. Never run two writers on the same files at once; run them one after another.",
				]),
		"Keep working while agents run. Steer with agent_send when a report shows drift; stop one that is no longer needed.",
		readOnly
			? "Verify before relying on an agent: a report is a claim, not a fact; spot-check its findings before you report them."
			: "Verify before relying on an agent: a report is a claim, not a fact. Review a writer's patch (`git diff <base> <ref>`), apply it with `git apply -3`, rerun its checks yourself; spot-check a reader's findings before they drive edits.",
		"A refused spawn (depth, budget or concurrency) means do the work yourself.",
		...(force ? [FORCED_DELEGATION] : []),
	].join("\n");
}

/** subagents=force: delegation is required, its shape is the builder's choice. */
export const FORCED_DELEGATION =
	"For this task, delegation is required: start at least one subagent before you finish. Choose what fits: researchers mapping code or data in parallel while you start, writers for independent parts, or a reviewer checking your fix while you run the tests. Integrate and verify their results yourself.";

/**
 * The lead's block (harness variant lead=fusion, after the fusion pattern): it
 * replaces the orchestration block for the root builder. The lead talks to
 * the user, plans, briefs and reviews; a persistent sidekick explores the
 * code first (the harness starts that round from the user's request) and
 * returns snippets the lead plans from, then implements, tests and fixes in
 * the lead's own checkout while the lead waits. `editTools` and `readTool`
 * are the surface's own names; `pair` tunes brief style, pushback and
 * exploration (src/domain/fusion-pairs.ts).
 */
export function fusionLeadInstructions(options: {
	readonly editTools: readonly string[];
	readonly readTool?: string;
	readonly pair?: FusionPairProfile;
}) {
	const edit = options.editTools.map((name) => `\`${name}\``).join(", ");
	const read = options.readTool ? ` (\`${options.readTool}\`)` : "";
	const pair = options.pair;
	const explores = pair?.sidekickExplores ?? true;
	return [
		`Subagents: you are the lead. You talk to the user, plan, brief and review, and rarely edit; a persistent sidekick (a writer agent, usually on a cheaper model) explores the code, implements, tests and fixes. It works directly in your checkout, one writer at a time: while it works you wait (the runtime makes no model call for you until its report arrives), then you review its changes in place. \`${AGENT_SEND_TOOL}\` sends it the next brief or feedback, or stops it; its reports arrive as messages.`,
		explores
			? `- Each user request starts with the sidekick's exploration: the runtime gives it the request before your first step, and its report (file paths with line ranges, the key snippets, the check commands and what the request touches) arrives with the request. Plan from those snippets; read a file yourself${read} only to fill a specific gap they leave, or send \`${AGENT_SEND_TOOL}\` with explore: true for another exploration round.`
			: `- Explore only enough to plan (researchers can explore for you), then hand implementation and testing to the sidekick early: \`${AGENT_TOOL}\` with role writer starts it.`,
		"- Short or trivial changes (one obvious edit): make them yourself; a round costs more than it saves there.",
		`- Your sidekick lives for this chat: it keeps its context from round to round and across the user's messages. Send it each next brief with \`${AGENT_SEND_TOOL}\` (id from its report); it sees only your messages, never this conversation. When none is running, \`${AGENT_TOOL}\` with role writer starts one.`,
		pair?.briefStyle === "prescriptive"
			? "- Brief prescriptively: the exact files and functions to change, the change itself step by step, the edge cases, and the commands that must pass. It follows the brief as written; it does not redesign."
			: `- Brief by outcome: the goal; constraints; the files and areas involved; edge cases; and the definition of done as concrete checks or commands that must pass.${pair?.pushback ? " It may push back on your approach with evidence; weigh that before you insist." : ""}`,
		"- Each build round's changes stay uncommitted in your working tree; its report lists the files and the exact diff command for the round (`git diff <start> <end>`). Review that diff and the evidence, and rerun the key check yourself: a report is a claim, not a fact. Revert what you reject (`git checkout -- <file>`) before the next round; the turn's usual commit publishes what you keep.",
		`- Wrong or incomplete: send specific feedback with \`${AGENT_SEND_TOOL}\` (what fails, where, what done looks like) for another round instead of fixing it yourself.`,
		`- A runtime notice tells you when the sidekick looks stuck (the same check failing again, the same error, no file changes, its budget used): re-brief it more prescriptively, or take over and edit yourself${edit ? ` (${edit})` : ""}. Take over also when it is clearly out of its depth.`,
		`- Your final answer comes after its last report. Researchers and reviewers read your VM read-only when a separate investigation or a second look helps. Stop the sidekick (\`${AGENT_SEND_TOOL}\` with stop: true) only when this chat no longer needs it. A refused spawn means do the work yourself.`,
	].join("\n");
}

/** A sidekick's role, per-round budget and report contract (lead mode fusion). */
export function sidekickRoleInstructions(budget: SubagentBudget) {
	const state = budget.sidekick;
	const pair = state?.pair;
	return [
		"You are the lead's sidekick: a persistent writer agent working directly in the lead's checkout on its VM. You explore the code, implement, test and fix what each brief asks; the lead plans from your findings, reviews your work in place and answers in this conversation with feedback or the next brief, each one a new round. The lead does not edit while you work.",
		"In an exploration round change no files: return the relevant file paths with line ranges, the key snippets quoted with line numbers (only what a plan needs), the commands that build and check the project and what they print now, and your open questions.",
		pair?.pushback
			? 'When a brief\'s approach looks wrong, say so in your report in a paragraph that starts with "Pushback:", with the evidence and what you would do instead, and still do the part that stands.'
			: "Follow each brief as written. When it is wrong or impossible, do what you can and say exactly why in your report instead of redesigning.",
		"Leave your changes uncommitted in the working tree: do not commit, stash, reset, switch branches or discard changes you did not make. The lead reviews each round's changes with git diff, and between rounds it may keep, change or revert them; each round starts from the checkout as the lead left it.",
		"Do the work yourself; you start no agents. You see only the lead's messages, not its conversation; do not ask it questions you can settle yourself.",
		`Your budget per round: ${budget.steps} steps, ${budget.minutes} minutes${state ? `, ${state.roundTokens.toLocaleString("en-US")} tokens; ${state.maxRounds} rounds at most per user request` : ""}. Near the end of a round you are told to wrap up; at the limit the round stops and whatever you have is reported.`,
		"Your final message each round is your report to the lead: what you found or changed, the exact commands you ran with their exit status, and what is unverified. The lead will check it, so claim only what you verified.",
	].join(" ");
}

const ROLE_WORK: Record<SubagentRole, string> = {
	writer:
		"You are a writer subagent working on a fork of your parent's VM: your own copy of its checkout, uncommitted work included. Make the change your brief asks for, inside the files it gives you, and verify it with the project's checks. Commit as you like; whatever is left uncommitted is committed for you when you finish, and your parent receives your work as a patch to review and apply.",
	researcher:
		"You are a read-only researcher subagent on your parent's VM. You cannot change the checkout and must not try: read, search and run read-only commands to answer the brief. Scratch files go in $HOME, your private directory.",
	reviewer:
		"You are a read-only reviewer subagent on your parent's VM. Review what the brief points at for correctness, regressions and missed requirements; run the tests that apply without changing the checkout (copy it into $HOME first if a run writes files). Cite file and line for every finding.",
	checker:
		"You are an independent checker subagent. Follow the instructions in your brief exactly and answer only with the JSON it asks for.",
};

/** A subagent's role, budget and report contract (its parent sees only the report). */
export function subagentRoleInstructions(
	role: SubagentRole,
	budget: SubagentBudget | null,
) {
	return [
		ROLE_WORK[role],
		"You see only your brief, not your parent's conversation; do not ask it questions you can settle yourself. Stay within the brief.",
		...(budget
			? [
					`Your budget: ${budget.steps} steps, ${budget.minutes} minutes, ${budget.tokens.toLocaleString("en-US")} tokens. Near the end you are told to wrap up; at the limit your turn stops and whatever you have is reported.`,
				]
			: []),
		role === "checker"
			? ""
			: "Your final message is your report to your parent: what you found or changed, the exact commands you ran with their exit status, and what is unverified. Your parent will check it, so claim only what you verified.",
	]
		.filter(Boolean)
		.join(" ");
}

/** The runtime notice at 90% of a budget (a checker's comes earlier and asks for its verdict). */
export function subagentWrapUpNotice(
	reason: string,
	role?: SubagentRole | null,
) {
	return role === "checker"
		? `Budget nearly used (${reason}). Stop investigating and answer now with only the JSON your brief asks for; a requirement you could not check is not met. This is a runtime notice, not a new request.`
		: `Budget nearly used (${reason}). Wrap up now: start nothing new, finish what you are on and write your report. This is a runtime notice, not a new request.`;
}
