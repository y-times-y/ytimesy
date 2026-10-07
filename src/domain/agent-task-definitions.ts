export const agentTaskToolDefinitions = [
	{
		name: "read_task_checks",
		description:
			"Read up to eight retained foreground child checks in one bundle: actual completion statuses, stdout/stderr tails, omission warnings and full-log pointers. Shared sourceProofs are freshly checked once and referenced by index. Require zero exit, no stop, and sourcesCurrent:true; hashes do not establish semantic correctness. Recover full logs with read_task_output for failures or uncertainty. Missing proof or completion is not success.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				references: {
					type: "array",
					items: { type: "string", format: "uuid" },
					minItems: 1,
					maxItems: 8,
					uniqueItems: true,
				},
			},
			required: ["taskId", "references"],
			additionalProperties: false,
		},
	},
	{
		name: "read_task_summary",
		description:
			"Read a bounded page of an authorized descendant's latest recorded message without waking it or preparing a VM. Follow nextStart to retrieve references omitted from list_tasks. This is agent-reported text, not verified command completion; read_task_output verifies its receipts. Never wake a finished child merely to resend stored information.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				start: { type: "integer", minimum: 0, maximum: 32000000 },
			},
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "read_task_output",
		description:
			"Read authorized child stdout/stderr and actual completion.status/stopped. view:summary returns a bounded tail, omission count, normalized UTF-8 content hash and fullOutput pointer; it is not the full log. Source-bound receipts include freshly checked sourcesCurrent for their declared files, not semantic correctness. Recover full pages for failures or uncertain details. Foreground references use background:false; only background IDs use background:true. Missing completion is not success. No new check or unrelated-task access.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				reference: { type: "string", format: "uuid" },
				background: { type: "boolean" },
				stream: { type: "string", enum: ["stdout", "stderr"] },
				view: { type: "string", enum: ["page", "summary"] },
				start: { type: "integer", minimum: 0, maximum: 32000000 },
			},
			required: ["taskId", "reference"],
			additionalProperties: false,
		},
	},
	{
		name: "integrate_reviewed_tasks",
		description:
			"Finalize the server-created batch integration draft after every batch sibling is reviewed, or integrate exact reviewed siblings into a fresh writable legacy draft. No inference; baseline checks remain unchanged. Early mark_task_reviewed calls stage patches in the batch draft while other builders work; do not create a duplicate or start_task first. Staged checkout fingerprints and complete batch membership are checked before final commands. Batched final-check and exact-file assignments cannot be omitted. additionalChecks adds original-contract requirements, never replaces baseline. sourcePaths must cover all changed files (up to eight); over-limit assignments require an integration builder, not dropped checks. Results retain actual exits/stops, full-log references and combined diff/hash. Recover missing logs with read_task_output, incomplete receipts with read_task_checks, and remaining diff pages with inspect_task_diff. Failures preserve the same child for repair. Exact-hash semantic acceptance remains required.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				sourcePaths: {
					type: "array",
					items: { type: "string", minLength: 1, maxLength: 2048 },
					minItems: 1,
					maxItems: 8,
				},
				additionalChecks: {
					type: "array",
					items: { type: "string", minLength: 1, maxLength: 16000 },
					maxItems: 8,
				},
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
			"Read the status and latest result summary of descendant tasks. Prompts are omitted by default to avoid replaying unchanged assignments; request includePrompts:true when their exact scope is needed.",
		inputSchema: {
			type: "object",
			properties: { includePrompts: { type: "boolean" } },
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
		name: "read_task_handoff",
		description:
			"Read one completed descendant's current exact diff, paged final summary and source-bound check bundle without waking a model. Discovers latest run_checks receipts automatically; failed attempts and incomplete discovery remain explicit. At most eight checks per read; remainingReferences and diff/summary cursors require further reads. Optional references retrieves known missing pages. Never treats summaries or missing checks as success; original-contract review and hash-bound acceptance remain required.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string" },
				start: { type: "integer", minimum: 0, maximum: 8388608 },
				references: {
					type: "array",
					minItems: 1,
					maxItems: 8,
					uniqueItems: true,
					items: { type: "string", format: "uuid" },
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
			"Accept a completed task's result after original-contract review. Writers require expectedSha256 from inspect_task_diff or read_task_handoff. Batched writers require verificationReferences covering every durably assigned command and exact verification file. Every supplied receipt must have zero exit, no stop and unchanged current declared sources. Invalid/stale evidence rejects acceptance. Unassigned legacy tasks retain manual review when references are omitted, not verified-check proof. Hashes and declared file bindings do not prove semantic correctness or complete changed-file coverage: inspect the full diff. Returned hash identifies accepted integration input.",
		inputSchema: {
			type: "object",
			properties: {
				verificationReferences: {
					type: "array",
					minItems: 1,
					maxItems: 8,
					items: { type: "string", format: "uuid" },
				},
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
