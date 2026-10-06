import type { AgentProviderId } from "./agent-provider";
import type {
	AgentTaskAccess,
	AgentTaskExecution,
	AgentTaskPlacement,
} from "./agent-task";
import {
	type AgentTaskToolName,
	agentTaskToolDefinitions,
} from "./agent-task-definitions";

export const AGENT_TASK_TOOL_REQUEST_PATH =
	"/tmp/ytimesy-agent-task-tool-request.json";
export const AGENT_TASK_TOOL_RESPONSE_PATH =
	"/tmp/ytimesy-agent-task-tool-response.json";

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

export function parseAgentTaskToolRequest(
	text: string | null,
): AgentTaskToolRequest | null {
	if (!text?.trim()) return null;
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		if (typeof value.id !== "string" || !value.id.trim()) return null;
		const tool = agentTaskToolDefinitions.find(
			(tool) => tool.name === value.tool,
		);
		if (!tool) {
			return null;
		}
		if (!isRecord(value.arguments)) return null;
		return {
			id: value.id,
			tool: tool.name,
			arguments: value.arguments,
		};
	} catch {
		return null;
	}
}

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
): "codex" | "claude" | "api" {
	const value = taskToolString(arguments_, "harness");
	if (value === "codex" || value === "claude" || value === "api") return value;
	return fallback === "claude" || fallback === "api" ? fallback : "codex";
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

export function serializeAgentTaskToolResponse(
	response: AgentTaskToolResponse,
) {
	return `${JSON.stringify(response)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
