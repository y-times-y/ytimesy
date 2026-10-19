/**
 * The work rules appended to a development eval task's prompt (hard set,
 * builder smoke runs). No plan proposal, commits, pull requests or
 * publishing: nobody is there to approve or receive them. With subagents=on
 * the builder may delegate, so the suffix does not tell it to work
 * "directly" (that read as "no delegation" next to the role line).
 */
export function evalWorkSuffix(input: {
	/** What the agent works in: a task's environment or a fixture repository. */
	readonly where: "environment" | "repository";
	/** What is finished when it stops. */
	readonly done: "task" | "change";
	readonly subagents: boolean;
}) {
	return `\n\nWork ${input.subagents ? "" : "directly "}in this ${input.where}: no plan proposal, commits, pull requests or publishing. Stop when the ${input.done} is done and checked.`;
}
