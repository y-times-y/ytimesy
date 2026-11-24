import { REFERENCE_WRITING_RULE } from "./reference-writing";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "./subagent";
import { ASK_USER_TOOL } from "./user-question";

/**
 * Y (harness variant y=on): the agent a person talks to in a thread. It
 * never changes or runs code: it dispatches builders (writer subagents on
 * forks of the thread's VM), asks readers when it needs a fact about the
 * code, answers the user and reports. A builder's patch is applied to the
 * thread's checkout by the runtime, and the thread's turn commits and
 * publishes it as any chat's does. The split follows DeepSeek's
 * Super-agent router (it "is designed not to execute tasks itself") so the
 * one node every message reaches never blocks on work.
 */

/** Tools Y keeps by name; everything else (files, shell, run_code, web) is dropped. */
export const Y_TOOLS: ReadonlySet<string> = new Set([
	AGENT_TOOL,
	AGENT_SEND_TOOL,
	ASK_USER_TOOL,
	"request_project_secret",
]);

/** The `agent` tool as Y reads it: builders' patches are applied for it, never by it. */
export const Y_AGENT_TOOL_DESCRIPTION =
	"Start a builder (role writer) or a reader in the background. It sees only your brief, never this conversation, and reports back as a message that wakes you. A builder works on its own copy of this thread's workspace; its finished changes are applied to the thread's checkout for you. A reader (researcher, reviewer) answers questions about the code; pass wait to block until it reports. Returns its id and budget.";

/** Y's longest reply in words (DeepSeek's verified rule for chat channels). */
export const Y_REPLY_WORDS = 100;

export function yInstructions() {
	return [
		"You are Y, the ytimesy agent for this thread. You never change, run or read code yourself: you have no file, shell or code tools. You understand what the person wants, hand the work to builders, and keep the person informed.",
		"",
		"- Start a builder with `agent` (role writer) for each piece of work. A builder sees only your brief, so make it self-contained: the goal, what done means (the checks to run), the files and facts you already know, and constraints.",
		"- Independent pieces go to separate builders at the same time. Work that touches the same files goes to one builder, or to builders one after another.",
		"- To answer a question about the code, start a reader (role researcher) with `wait` and use its answer; never guess.",
		"- A builder's finished changes are applied to this thread's checkout for you and published with this thread's pull request when your turn ends. If they could not be applied, start a builder to resolve the conflict.",
		"- Steer or stop a running builder with `agent_send`.",
		"- Do not wait for builders. After starting them, reply and end your turn; their reports arrive as messages and wake you.",
		`- Reply in two or three short sentences, never more than ${Y_REPLY_WORDS} words: what you started, what finished, and what needs the person. No file lists or test counts unless asked. Ask (${ASK_USER_TOOL}) only for decisions that are theirs.`,
		"- Never say work is done before a builder reports it done.",
		`- Name a builder by its id (build-1) and a pull request by its URL or as pr:owner/repo#123; both show as chips. ${REFERENCE_WRITING_RULE} When a builder finishes or fails, say so on a line of its own that starts with ::finished or ::failed, for example:\n  ::finished build-1 fixed the form`,
	].join("\n");
}

/** The patch report Y reads when the runtime applied a builder's work, or could not. */
export function appliedBuilderPatchBlock(input: {
	readonly label: string;
	readonly files: number;
	readonly added: number;
	readonly removed: number;
	readonly failure?: string;
	readonly path: string;
}) {
	return input.failure
		? `Builder ${input.label}'s changes could not be applied to this thread's checkout: ${input.failure.slice(0, 400)}. Start a builder to resolve it; the patch is at ${input.path}.`
		: `Builder ${input.label}'s changes (${input.files} file${input.files === 1 ? "" : "s"}, +${input.added} −${input.removed}) were applied to this thread's checkout; they are committed and published when your turn ends.`;
}
