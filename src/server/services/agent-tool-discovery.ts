import { type ModelMessage, type ToolSet, toolSearch } from "ai";
import type { HarnessModelFamily } from "#/domain/harness-model-profile";
import type { SessionItem } from "#/domain/session-item";

// Common coding and coordination operations should never require a search round trip.
const CORE_TOOLS = new Set([
	"batch_read",
	"list_files",
	"search_files",
	"read_file",
	"read_files",
	"read_code",
	"read_repository_guidance",
	"read_environment_report",
	"inspect_project_evidence",
	"search_project_memory",
	"read_project_memory",
	"read_tool_output",
	"inspect_changes",
	"create_file",
	"replace_text",
	"apply_patch",
	"apply_patches",
	"bash",
	"start_command",
	"read_command",
	"wait_command",
	"run_checks",
	"read_task_capacity",
	"plan_parallel_work",
	"create_task",
	"launch_ready_tasks",
	"edit_task",
	"start_task",
	"list_tasks",
	"inspect_task_diff",
	"read_task_summary",
	"read_task_output",
	"read_task_checks",
	"mark_task_reviewed",
	"integrate_reviewed_tasks",
	"send_task_message",
	"report_task_blocked",
]);

// Builders can still discover and invoke coordination tools when further delegation
// is needed. Their ordinary coding requests need not repeatedly carry those schemas.
const COORDINATION_TOOLS = new Set([
	"read_task_capacity",
	"plan_parallel_work",
	"create_task",
	"launch_ready_tasks",
	"edit_task",
	"start_task",
	"list_tasks",
	"inspect_task_diff",
	"read_task_summary",
	"read_task_output",
	"read_task_checks",
	"mark_task_reviewed",
	"integrate_reviewed_tasks",
	"send_task_message",
]);

const SINGLE_EDIT_ALIASES = new Set([
	"create_file",
	"replace_text",
	"apply_patch",
]);

const OPTIONAL_WORKFLOW_TOOLS = new Set([
	"start_command",
	"read_command",
	"wait_command",
	"read_project_memory",
	"plan_parallel_work",
	"edit_task",
	"start_task",
]);
const LEAD_OPTIONAL_INVESTIGATION_TOOLS = new Set([
	"list_files",
	"inspect_changes",
	"inspect_project_evidence",
	"search_project_memory",
	"read_tool_output",
]);

/** Reconstruct discovery from the durable journal, not SDK process-local state. */
export function discoverableAgentTools(
	tools: ToolSet,
	messages: ModelMessage[],
	checkpointTools: readonly string[] = [],
	toolSurface: "coordination" | "implementation" = "coordination",
	modelFamily?: HarnessModelFamily,
): ToolSet {
	if (Object.keys(tools).length === 0) return tools;
	const known = new Set<string>(checkpointTools);
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "tool-call") known.add(part.toolName);
			if (
				part.type !== "tool-result" ||
				part.toolName !== "search_tools" ||
				part.output.type !== "json"
			)
				continue;
			const output = part.output.value;
			if (
				!output ||
				typeof output !== "object" ||
				Array.isArray(output) ||
				!("tools" in output) ||
				!Array.isArray(output.tools)
			)
				continue;
			for (const match of output.tools) {
				if (
					match &&
					typeof match === "object" &&
					!Array.isArray(match) &&
					typeof match.name === "string"
				)
					known.add(match.name);
			}
		}
	}
	return {
		...Object.fromEntries(
			Object.entries(tools).map(([name, definition]) => [
				name,
				{
					...definition,
					deferLoading:
						!known.has(name) &&
						(!CORE_TOOLS.has(name) ||
							OPTIONAL_WORKFLOW_TOOLS.has(name) ||
							(toolSurface === "coordination" &&
								LEAD_OPTIONAL_INVESTIGATION_TOOLS.has(name)) ||
							(toolSurface === "implementation" &&
								(COORDINATION_TOOLS.has(name) ||
									(Boolean(tools.apply_patches) &&
										SINGLE_EDIT_ALIASES.has(name) &&
										!(modelFamily === "anthropic" && name === "replace_text") &&
										definition.type !== "provider")))),
				},
			]),
		),
		search_tools: toolSearch(),
	};
}

/** UI/tool receipts outlive model compaction, including opaque native compaction. */
export function discoveredToolsFromSession(
	items: readonly SessionItem[],
): string[] {
	const known = new Set<string>();
	for (const item of items) {
		if (item.kind !== "dynamicToolCall") continue;
		known.add(item.tool);
		if (item.tool !== "search_tools" || !item.output) continue;
		try {
			const parsed = JSON.parse(item.output);
			const output = parsed?.type === "json" ? parsed.value : parsed;
			if (!Array.isArray(output?.tools)) continue;
			for (const candidate of output.tools)
				if (typeof candidate?.name === "string") known.add(candidate.name);
		} catch {
			/* Incomplete/failed search output does not establish discovery. */
		}
	}
	return [...known];
}
