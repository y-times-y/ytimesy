import { agentTaskToolDefinitions } from "#/domain/agent-task-definitions";

const marker = "TASK_TOOL_DEFINITIONS = [] # YTIMESY_TASK_TOOL_DEFINITIONS";

export function embedTaskToolDefinitions(source: string): string {
	if (source.split(marker).length !== 2)
		throw new Error("Task tool source must contain exactly one schema marker.");
	return source.replace(
		marker,
		() =>
			`TASK_TOOL_DEFINITIONS = json.loads(${JSON.stringify(JSON.stringify(agentTaskToolDefinitions))})`,
	);
}
