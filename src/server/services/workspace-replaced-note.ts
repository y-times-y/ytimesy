import type { ToolSet } from "ai";

/**
 * What the agent is told once after its chat's machine was replaced (a start
 * that kept failing, see executeSessionMachinePlan "replace-unstartable"):
 * the files come back from the chat's branch on GitHub, so anything after the
 * last push is missing and is the agent's to redo from its own history.
 */
export function workspaceReplacedNote() {
	return [
		"Workspace notice: this chat's machine was replaced because the previous one would not start.",
		"Your repository was cloned again from your branch on GitHub, at its last pushed commit.",
		"Anything you changed after your last push is missing, and processes you had running (dev servers, watchers) are not running.",
		"Before you continue, run `git status` and `git log`, compare them with what you did earlier in this conversation, redo anything that is missing, and restart the servers you were using.",
	].join(" ");
}

/**
 * Adds `note` to the first result a tool returns, then never again: a string
 * result gets it as a first paragraph, an object result as `workspaceNotice`.
 * A result of another shape (a list, a stream) is left alone and the note
 * waits for the next call, so it is never lost on an unsuitable result.
 * `take` returns the pending note and clears it; null when there is none.
 */
export function withWorkspaceNote(
	tools: ToolSet,
	take: () => string | null,
): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, definition]) => {
			const execute = definition.execute;
			if (!execute) return [name, definition];
			return [
				name,
				{
					...definition,
					execute: async (...args: Parameters<typeof execute>) => {
						const result = await execute(...args);
						return noted(result, take);
					},
				},
			];
		}),
	) as ToolSet;
}

function noted(result: unknown, take: () => string | null): unknown {
	if (typeof result === "string") {
		const note = take();
		return note ? `${note}\n\n${result}` : result;
	}
	if (
		result &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		!(Symbol.asyncIterator in result)
	) {
		const note = take();
		return note ? { workspaceNotice: note, ...result } : result;
	}
	return result;
}
