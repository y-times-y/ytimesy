import type { SessionItem } from "./session-item";
import { fileChangesFromShellCommand } from "./shell-file-change";

/**
 * Who produced a piece of a chat, for training use
 * (src/content/legal/training-opt-in.md):
 * - "user": what the person wrote or sent (messages, attachments, feedback);
 * - "environment": what the world answered (command and test output, files
 *   read from the repository as it was, pull request outcomes);
 * - "model": anything an AI model wrote (replies, reasoning, plans, tool-call
 *   arguments, generated code and diffs), on every provider and route.
 *
 * Training data is "user" and "environment" only, never "model". No export
 * pipeline exists yet: any export of `api_turn` rows marked
 * `training_eligible` must pass the turn's items through trainingExportParts
 * and copy nothing else.
 */
export type TrainingSource = "user" | "environment" | "model";

export type TrainingPart = {
	readonly source: TrainingSource;
	/** The session item it came from. */
	readonly itemId: string;
	/** Which field of the item, such as "text" or "output". */
	readonly field: string;
	readonly content: string;
};

/** A turn's result that is not a session item. */
export type TrainingOutcome =
	| {
			readonly kind: "pullRequest";
			readonly state: "merged" | "closed" | "open";
	  }
	| {
			readonly kind: "userFeedback";
			readonly rating: "up" | "down";
			readonly comment?: string;
	  };

/**
 * Tools whose output is the environment's answer (a shell, a file read, a
 * search). Any other tool's output counts as model output: a helper agent's
 * report or a tool that echoes model text must never pass as environment.
 */
const ENVIRONMENT_TOOLS = new Set([
	"bash",
	"shell",
	"exec_command",
	"read",
	"read_file",
	"grep",
	"glob",
	"ls",
	"web_search",
	"inspect_changes",
	"read_repository_guidance",
	"read_environment_report",
	"call_mcp_tool",
	"search_mcp_tools",
]);

/**
 * Paths the model changed anywhere in this chat. Reading such a file, or
 * running a command that names it, can show model-written code, so that
 * output counts as model output: only the repository as it was before the
 * model touched it is environment. Errs toward leaving out (a read before the
 * edit is dropped too).
 */
function modelWrittenPaths(items: readonly SessionItem[]) {
	const paths = new Set<string>();
	for (const item of items) {
		if (item.kind === "fileChange")
			for (const change of item.changes) paths.add(change.path);
		if (item.kind === "commandExecution")
			for (const change of fileChangesFromShellCommand(item.command))
				paths.add(change.path);
	}
	return paths;
}

function namesWrittenPath(text: string | undefined, written: Set<string>) {
	if (!text) return false;
	for (const path of written) {
		if (text.includes(path)) return true;
		const base = path.split("/").pop();
		if (base && base.length > 2 && text.includes(base)) return true;
	}
	return false;
}

/**
 * Splits one session item into its parts, each with its source. `written` is
 * the set of paths the model changed earlier in the chat (modelWrittenPaths).
 */
export function sessionItemTrainingParts(
	item: SessionItem,
	written: Set<string> = new Set(),
): readonly TrainingPart[] {
	const part = (
		source: TrainingSource,
		field: string,
		content: string | null | undefined,
	): TrainingPart[] =>
		content ? [{ source, itemId: item.id, field, content }] : [];
	switch (item.kind) {
		case "userMessage":
			// The memory recall is not part of the message: the memory
			// repository is never training data.
			return [
				...part("user", "text", item.text),
				...(item.attachments ?? []).flatMap((attachment, index) =>
					part("user", `attachments.${index}`, JSON.stringify(attachment)),
				),
			];
		case "agentMessage":
			return part("model", "text", item.text);
		case "reasoning":
			return part("model", "summaries", item.summaries.join("\n"));
		case "plan":
		case "planProposal":
			return part("model", "text", item.text);
		case "secretRequest":
			return part(
				"model",
				"reason",
				"secrets" in item
					? item.secrets
							.map(({ name, reason }) => `${name}: ${reason}`)
							.join("\n")
					: item.reason,
			);
		case "userQuestion":
			return part("model", "questions", JSON.stringify(item.questions));
		case "pushApproval":
			return part("model", "summary", item.summary);
		case "memorySave":
			return part("model", "lines", JSON.stringify(item.lines));
		case "commandExecution": {
			const derived = namesWrittenPath(item.command, written);
			return [
				...part("model", "command", item.command),
				...part(derived ? "model" : "environment", "output", item.output),
				...part(
					"environment",
					"exitCode",
					item.exitCode === null ? null : String(item.exitCode),
				),
			];
		}
		case "fileChange":
			return [
				// What changed where is the repository's answer; the diff itself
				// is code the model generated.
				...part(
					"environment",
					"changes",
					JSON.stringify(
						item.changes.map(({ path, change, additions, deletions }) => ({
							path,
							change,
							additions,
							deletions,
						})),
					),
				),
				...item.changes.flatMap((change, index) =>
					part("model", `changes.${index}.preview`, change.preview),
				),
			];
		case "mcpToolCall":
			return [
				...part("model", "tool", `${item.server}.${item.tool}`),
				...part("environment", "status", item.status),
			];
		case "dynamicToolCall": {
			const environment =
				ENVIRONMENT_TOOLS.has(item.tool) &&
				!namesWrittenPath(item.input, written);
			return [
				...part("model", "input", item.input),
				...part(environment ? "environment" : "model", "output", item.output),
				...part("environment", "status", item.status),
			];
		}
		case "canvas":
			// The document is the model's own output.
			return [
				...part("model", "title", item.title),
				...part("model", "html", item.html),
			];
		case "webSearch":
			return part("model", "query", item.query);
		case "error":
		case "notice":
			return part("environment", "message", item.message);
		case "modelSwitch":
			return part("environment", "message", item.message);
		case "handoff":
			// A local agent's transcript and its summary hold model replies.
			return [
				...part("model", "context", item.context),
				...part(
					"model",
					"summary",
					item.summary ? JSON.stringify(item.summary) : null,
				),
			];
		case "unknown":
			return part("model", "type", item.type);
		default: {
			const unhandled: never = item;
			return unhandled;
		}
	}
}

/** Pull request outcomes are the environment's; ratings are the user's. */
export function outcomeTrainingParts(
	outcome: TrainingOutcome,
	id: string,
): readonly TrainingPart[] {
	if (outcome.kind === "pullRequest")
		return [
			{
				source: "environment",
				itemId: id,
				field: "state",
				content: outcome.state,
			},
		];
	return [
		{ source: "user", itemId: id, field: "rating", content: outcome.rating },
		...(outcome.comment
			? [
					{
						source: "user" as const,
						itemId: id,
						field: "comment",
						content: outcome.comment,
					},
				]
			: []),
	];
}

/** Every part of a chat with its source, in order. */
export function chatTrainingParts(
	items: readonly SessionItem[],
	outcomes: readonly {
		readonly id: string;
		readonly outcome: TrainingOutcome;
	}[] = [],
): readonly TrainingPart[] {
	const written = modelWrittenPaths(items);
	return [
		...items.flatMap((item) => sessionItemTrainingParts(item, written)),
		...outcomes.flatMap(({ id, outcome }) => outcomeTrainingParts(outcome, id)),
	];
}

/**
 * What a training export may copy from a chat: user and environment parts
 * only. Model output is never training data, whichever provider or route
 * (Anthropic, OpenAI, xAI, OpenRouter, Codex, Claude Code, Grok, our own)
 * produced it.
 */
export function trainingExportParts(
	items: readonly SessionItem[],
	outcomes: readonly {
		readonly id: string;
		readonly outcome: TrainingOutcome;
	}[] = [],
): readonly TrainingPart[] {
	return chatTrainingParts(items, outcomes).filter(
		(part) =>
			part.source !== "model" &&
			// Attachments are the user's, but the policy leaves them out until
			// a separate, explicit choice exists.
			!part.field.startsWith("attachments."),
	);
}
