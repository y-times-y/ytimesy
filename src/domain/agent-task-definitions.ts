/** A subagent's one task-control tool: ask its parent for a missing decision. */
export const reportTaskBlockedDefinition = {
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
} as const;
