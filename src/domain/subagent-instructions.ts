import type { SubagentBudget, SubagentRole } from "./subagent";

/**
 * The orchestration block (subagents=on): when to delegate, how to call
 * the agent tool, how to brief, coordinate and verify. Shown to every agent
 * that has the agent tool (never a checker). The agent tool itself is
 * deferred (find_tools, or run_code in code mode primary), so its role list
 * and arguments are here: knowing how to call it takes no lookup.
 */
export function orchestratorInstructions(
	options: {
		codeMode?: boolean | "primary";
		/** A read-only subagent: it may start readers, never writers. */
		readOnly?: boolean;
	} = {},
) {
	const { codeMode, readOnly } = options;
	const roles = readOnly
		? '"researcher" | "reviewer" | "checker"'
		: '"writer" | "researcher" | "reviewer" | "checker"';
	const parallel = readOnly
		? 'await Promise.all([tools.agent({ role: "researcher", title: "Map the parser", brief: "…" }), tools.agent({ role: "researcher", title: "Map the cache", brief: "…" })])'
		: 'await Promise.all([tools.agent({ role: "writer", title: "Fix pricing rounding", brief: "…" }), tools.agent({ role: "writer", title: "Build the release bundle", brief: "…" })])';
	const howParallel = codeMode
		? `start them together from one run_code program: ${parallel}`
		: "start them together: call agent once per part in the same step";
	return [
		`Subagents: \`agent\` (${codeMode === "primary" ? "call it from run_code: tools.agent(args)" : `load it with find_tools${codeMode ? ", or call it from run_code" : ""}`}) starts a background agent with only your brief and returns its id at once; \`agent_send\` steers or stops one. Their reports arrive as messages.`,
		`Arguments: agent({ role: ${roles}, title: string, brief?: string, wait?: boolean }); brief is required except for a checker, which takes none; wait (readers only) blocks until the report. agent_send({ id, message?, stop? }).`,
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
	].join("\n");
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
