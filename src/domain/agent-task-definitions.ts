export const agentTaskToolDefinitions = [
	{
		name: "read_task_output",
		description:
			"Read retained stdout or stderr evidence from an authorized descendant task. Use background:true for a background command ID to also observe its actual completion status; otherwise provide a tool output reference. Use this for child verification; read_tool_output and read_command are scoped to your own session. Follow nextStart for complete retained output. Does not execute a new check or grant access to unrelated tasks.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				reference: { type: "string", format: "uuid" },
				background: { type: "boolean" },
				stream: { type: "string", enum: ["stdout", "stderr"] },
				start: { type: "integer", minimum: 0, maximum: 32000000 },
			},
			required: ["taskId", "reference"],
			additionalProperties: false,
		},
	},
	{
		name: "integrate_reviewed_tasks",
		description:
			"Integrate two or more exact reviewed siblings into a fresh writable child draft without model inference, then run baseline project checks. Successful results include checkResults with actual exits, stopped status and retained output references; use read_task_output with this task ID and those references, not another model turn or duplicate successful checks merely to fetch evidence. Do not start_task first. Conflicts or failed checks preserve the child for agent repair. The combined diff still requires lead review.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				sources: {
					type: "array",
					minItems: 2,
					maxItems: 8,
					items: {
						type: "object",
						properties: {
							taskId: { type: "string" },
							sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
							base: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
						},
						required: ["taskId", "sha256", "base"],
						additionalProperties: false,
					},
				},
			},
			required: ["taskId", "sources"],
			additionalProperties: false,
		},
	},
	{
		name: "read_task_capacity",
		description:
			"Read current worker/account capacity before planning parallel child launches. Availability is a snapshot, not a reservation; start_task enforces admission atomically.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "list_peers",
		description:
			"Discover agents in your coordination group, including siblings and their bounded objectives. Competing implementations are isolated. No transcripts are broadcast.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "send_peer_message",
		description:
			"Queue findings, ownership negotiation, or a handoff to a started peer in your coordination group. Active peers receive messages at their next runtime safe point without cancelling work; idle peers may be woken. This does not grant task-control permissions.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				message: { type: "string", minLength: 1, maxLength: 8000 },
			},
			required: ["taskId", "message"],
			additionalProperties: false,
		},
	},
	{
		name: "create_task",
		description:
			"Draft a bounded child task. Defaults to no compute. Set startImmediately:true only for a complete, ready task after checking capacity; it uses the same validated start and admission path without a second model round trip. Rejected starts retain and return the draft ID. The child inherits no conversation, so include all requirements and repository preflight.",
		inputSchema: {
			type: "object",
			properties: {
				startImmediately: { type: "boolean" },
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
					enum: ["codex", "claude", "api"],
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
					enum: ["codex", "claude", "api"],
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
			"Read a completed task's current diff and exact patch SHA-256 before accepting its work. Pass that hash to an integration builder; truncated diffs require further inspection before acceptance.",
		inputSchema: {
			type: "object",
			properties: {
				start: { type: "integer", minimum: 0, maximum: 8388608 },
				taskId: {
					type: "string",
				},
			},
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "import_reviewed_task",
		description:
			"Writable builders only: import an exact Git patch from a completed, parent-reviewed sibling with the same base revision, including committed changes since its saved checkout base. expectedSha256 must come from the parent's inspect_task_diff result; changed patches fail. Use a fresh integration builder after parallel work is reviewed; do not resend source through messages. Conflicts fail without a forced merge. Verify the combined checkout and obtain its own review before accepting the result; successful turn completion automatically hands off a draft PR.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
			},
			required: ["taskId", "expectedSha256"],
			additionalProperties: false,
		},
	},
	{
		name: "mark_task_reviewed",
		description:
			"Accept a completed task's result. For writable tasks supply expectedSha256 from inspect_task_diff; changed patches are rejected. The returned hash is the accepted identity for integration.",
		inputSchema: {
			type: "object",
			properties: {
				expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
				taskId: {
					type: "string",
				},
			},
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "select_competition_winner",
		description:
			"Select one completed and reviewed independent leader as winner after comparing evidence. Does not merge or publish.",
		inputSchema: {
			type: "object",
			properties: { taskId: { type: "string" } },
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "publish_task",
		description:
			"Commit a reviewed task, push its branch, and open a draft pull request. Multi-repository projects require repositoryFullName; publish each repository separately.",
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
				repositoryFullName: { type: "string" },
			},
			required: ["taskId", "title"],
			additionalProperties: false,
		},
	},
] as const;

export type AgentTaskToolName =
	(typeof agentTaskToolDefinitions)[number]["name"];
