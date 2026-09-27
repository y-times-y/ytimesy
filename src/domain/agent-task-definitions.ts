export const agentTaskToolDefinitions = [
	{
		name: "create_task",
		description:
			"Draft a bounded child task without starting compute. The prompt must be complete because the child inherits no conversation.",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
				},
				prompt: {
					type: "string",
				},
				modelId: {
					type: "string",
				},
				harness: {
					enum: ["codex", "claude"],
				},
				placement: {
					enum: ["shared", "fresh"],
				},
				access: {
					enum: ["read_only", "read_write"],
				},
				execution: {
					enum: ["parallel", "stacked"],
				},
				dependsOnTaskId: {
					type: "string",
				},
			},
			required: ["title", "prompt"],
			additionalProperties: false,
		},
	},
	{
		name: "edit_task",
		description:
			"Edit an unstarted descendant task draft before it consumes compute.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
				},
				title: {
					type: "string",
				},
				prompt: {
					type: "string",
				},
				modelId: {
					type: "string",
				},
				harness: {
					enum: ["codex", "claude"],
				},
				placement: {
					enum: ["shared", "fresh"],
				},
				access: {
					enum: ["read_only", "read_write"],
				},
				execution: {
					enum: ["parallel", "stacked"],
				},
				dependsOnTaskId: {
					type: "string",
				},
			},
			required: ["taskId", "title", "prompt"],
			additionalProperties: false,
		},
	},
	{
		name: "start_task",
		description:
			"Start a validated task draft. Stacked work waits for a completed, reviewed predecessor.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
				},
			},
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "list_tasks",
		description:
			"Read the status and latest result summary of descendant tasks.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "send_task_message",
		description: "Send focused follow-up guidance to a descendant task.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
				},
				message: {
					type: "string",
				},
			},
			required: ["taskId", "message"],
			additionalProperties: false,
		},
	},
	{
		name: "request_task_wrap_up",
		description:
			"Stop scope expansion and ask a descendant task to return its best concise result now.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
				},
			},
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "report_task_blocked",
		description:
			"Report the concrete question preventing this task from continuing. This notifies and wakes the parent.",
		inputSchema: {
			type: "object",
			properties: {
				question: {
					type: "string",
				},
			},
			required: ["question"],
			additionalProperties: false,
		},
	},
	{
		name: "inspect_task_diff",
		description:
			"Read a completed task's current diff before accepting its work.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
				},
			},
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "mark_task_reviewed",
		description:
			"Record that the parent inspected and accepted a completed task's result.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
				},
			},
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "publish_task",
		description:
			"Commit a reviewed task, push its branch, and open a draft pull request.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
				},
				title: {
					type: "string",
				},
				body: {
					type: "string",
				},
			},
			required: ["taskId", "title"],
			additionalProperties: false,
		},
	},
] as const;

export type AgentTaskToolName =
	(typeof agentTaskToolDefinitions)[number]["name"];
