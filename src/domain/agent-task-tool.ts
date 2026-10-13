import type { AgentProviderId } from "./agent-provider";
import type {
	AgentTaskAccess,
	AgentTaskExecution,
	AgentTaskPlacement,
} from "./agent-task";
import type { AgentTaskToolName } from "./agent-task-definitions";

export type AgentTaskToolRequest = {
	readonly id: string;
	readonly tool: AgentTaskToolName;
	readonly arguments: Record<string, unknown>;
};

export type AgentTaskToolResponse = {
	readonly id: string;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
	readonly requestFingerprint?: string;
};

export function taskToolString(
	arguments_: Record<string, unknown>,
	key: string,
) {
	const value = arguments_[key];
	return typeof value === "string" ? value.trim() : "";
}

export function taskToolHarness(
	arguments_: Record<string, unknown>,
	fallback: AgentProviderId,
): AgentProviderId {
	const value = taskToolString(arguments_, "harness");
	return value === "codex" || value === "api" ? value : fallback;
}

export function taskToolPlacement(
	arguments_: Record<string, unknown>,
): AgentTaskPlacement {
	return taskToolString(arguments_, "placement") === "shared"
		? "shared"
		: "fresh";
}

export function taskToolAccess(
	arguments_: Record<string, unknown>,
): AgentTaskAccess {
	return taskToolString(arguments_, "access") === "read_only"
		? "read_only"
		: "read_write";
}

export function taskToolExecution(
	arguments_: Record<string, unknown>,
): AgentTaskExecution {
	return taskToolString(arguments_, "execution") === "stacked"
		? "stacked"
		: "parallel";
}

/** Briefs carry goal, constraints, success checks and key findings; builders read the source themselves. */
const TASK_BRIEF_MAX_CHARACTERS = 2500;

export function taskBriefTooLong(prompt: string) {
	return prompt.length > TASK_BRIEF_MAX_CHARACTERS
		? `Brief is ${prompt.length} characters; keep it under ${TASK_BRIEF_MAX_CHARACTERS}: goal, constraints, success checks and key findings with paths. Do not restate source the builder will read.`
		: null;
}
