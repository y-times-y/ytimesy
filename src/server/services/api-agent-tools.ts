import { jsonSchema, type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { agentTaskToolDefinitions } from "#/domain/agent-task-definitions";
import { WorkspaceId } from "#/domain/ids";
import {
	parallelWorkPlan,
	scheduleParallelWork,
} from "#/domain/parallel-work-plan";
import { knowledgeForTask } from "#/domain/project-knowledge";
import {
	cachedSourceEvidence,
	sourceEvidenceMatches,
} from "#/domain/project-source-evidence";
import { availableChildSlots } from "../adapters/agent-capacity";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	contextArchiveReference,
	readModelContextArchive,
	searchModelContextArchives,
} from "../adapters/context-archives";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { apiAgentBrowserTools } from "./api-agent-browser-tools";
import {
	apiAgentCommandTools,
	verifyPatchedCheckout,
} from "./api-agent-command-tools";
import { readableHistory } from "./api-agent-context";
import { apiAgentFileTools } from "./api-agent-file-tools";
import { apiAgentLanguageTools } from "./api-agent-language-tools";
import { scopedShellCommand } from "./api-command-scope";
import { batchedAgentReads } from "./batched-agent-reads";
import { codeToolingTools } from "./code-tooling";
import { dapDebuggerTools } from "./dap-debugger";
import { runAgentTaskTool } from "./harness-workspace-session";
import { repositorySearchCommand } from "./indexed-repository-search";
import { journaledToolOperation } from "./journaled-tool-operation";
import { nodeDebuggerTools } from "./node-debugger";
import { loadCloudProjectMemoryDocument } from "./project-knowledge";
import { projectMemoryTools } from "./project-memory-tools";
import { inspectProjectSourceEvidence } from "./project-source-evidence";
import {
	launchReadyTasks,
	readyTaskLaunch,
	readyTaskPrompt,
} from "./ready-task-launch";
import { repositoryGuidanceTool } from "./repository-guidance";
import { repositoryToolPath as repositorySearchPath } from "./repository-tool-path";
import { scopedToolExecution } from "./tool-execution-identity";
import type { WorkspaceMachines } from "./workspace-machines";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function apiAgentTools(
	input: {
		machines: WorkspaceMachines;
		session: AgentSessionRecord;
		turnId: string;
		toolCallPrefix?: string;
		nativePatch?: boolean;
		signal: AbortSignal;
	} & ({ cwd: string } | { workspace: () => Promise<AgentToolWorkspace> }),
): ToolSet {
	const { machines, session, signal } = input;
	const executionIdentity = scopedToolExecution();
	const readOnly =
		!session.parentSessionId || session.taskAccess !== "read_write";
	const workspace = async (): Promise<AgentToolWorkspace> => {
		signal.throwIfAborted();
		if ("workspace" in input) return input.workspace();
		if (!session.providerRef) throw new Error("Task workspace is unavailable.");
		return { machines, vm: WorkspaceId(session.providerRef), cwd: input.cwd };
	};
	const output = agentOutputArtifacts({
		workspace,
		sessionId: session.id,
		signal,
	});
	const once = (id: string, run: () => Promise<unknown>) =>
		journaledToolOperation(
			{
				sessionId: session.id,
				requestId: `${input.turnId}:${input.toolCallPrefix ?? ""}${id}`,
				fingerprint: executionIdentity.fingerprint(),
				signal,
			},
			run,
		);
	const tools: ToolSet = {
		...projectMemoryTools({ session, workspace, once }),
		plan_parallel_work: tool({
			description:
				"Check a proposed bounded dependency graph and file ownership before launching children. Returns an advisory critical-path-first schedule using your explicit duration estimates and current capacity. Does not draft/start tasks or reserve slots. Unordered overlapping writers and cycles are rejected. Multiple prerequisites require reviewed integration before starting their dependent child, not a single stacked predecessor.",
			inputSchema: parallelWorkPlan,
			execute: async (plan) => {
				const available = Math.min(
					await availableChildSlots(session.userId, session.id),
					5,
				);
				if (available < 1)
					return {
						status: "no-capacity",
						instruction:
							"Steer or wait for existing children; do not start duplicate tasks.",
					};
				return {
					...scheduleParallelWork(plan, available),
					capacity: available,
					reservation: false,
				};
			},
		}),
		inspect_project_evidence: tool({
			description:
				"Validate cached project discovery packets against this checkout's revision, cleanliness and exact tracked-file hashes. sources_current means only source freshness, not semantic correctness or verified tests. Stale or missing evidence requires investigation; never infer current implementation from old Markdown alone.",
			inputSchema: z.object({ task: z.string().min(1).max(2000) }),
			execute: async ({ task }) => {
				const document = await loadCloudProjectMemoryDocument(session);
				const packets = cachedSourceEvidence(
					knowledgeForTask(document, task, true),
				);
				if (!packets.length) return { available: false, entries: [] };
				const checkout = await workspace();
				return {
					available: true,
					entries: await Promise.all(
						packets.map(async (packet) => {
							const current = await inspectProjectSourceEvidence(
								checkout,
								packet.evidence.sources.map((source) => source.path),
							);
							return {
								key: packet.key,
								status: sourceEvidenceMatches(packet.evidence, current)
									? "sources_current"
									: "stale_or_unverifiable",
								current,
							};
						}),
					),
				};
			},
		}),
		read_repository_guidance: repositoryGuidanceTool({ workspace, signal }),
		list_files: tool({
			description:
				"List tracked and non-ignored untracked repository files. Scope path to the task's known directory; omit it only for an unknown repository layout. Paths are literal, not Git pathspec patterns.",
			inputSchema: z.object({ path: repositorySearchPath.optional() }),
			execute: async ({ path }) => {
				const scope =
					path === undefined
						? ""
						: ` -- ${quote(repositorySearchPath.parse(path))}`;
				signal.throwIfAborted();
				const { cwd } = await workspace();
				const result = await output.capture(
					`git --literal-pathspecs -C ${quote(cwd)} ls-files --cached --others --exclude-standard${scope}`,
				);
				return result;
			},
		}),
		search_files: tool({
			description:
				"Search tracked and non-ignored untracked repository text. Prefer literal:true for exact text. Default query is a Git regular expression; wordBoundary:true requires Git whole-word matching. When experimental indexing is enabled, eligible literal queries and plain ASCII identifiers in larger repositories use a refreshed local text index with Git-confirmed matches; other queries use Git search. Scope path to known task code; the path is literal, not a Git pattern. Exit 1 means no matches, not an execution error. No per-file match cutoff. Follow stdoutNextStart using read_tool_output and the returned reference for complete results; output_limit explicitly marks incomplete evidence.",
			inputSchema: z.object({
				query: z.string().min(1).max(200),
				literal: z.boolean().default(false),
				wordBoundary: z.boolean().default(false),
				path: repositorySearchPath.optional(),
			}),
			execute: async ({
				query,
				literal = false,
				wordBoundary = false,
				path,
			}) => {
				const scope =
					path === undefined ? "." : repositorySearchPath.parse(path);
				signal.throwIfAborted();
				const { cwd } = await workspace();
				const result = await output.capture(
					repositorySearchCommand({
						cwd,
						query,
						literal,
						wordBoundary,
						useIndex: process.env.YTIMESY_INDEXED_SEARCH_ENABLED === "1",
						path: scope,
					}),
				);
				return result;
			},
		}),
		read_context_archive: tool({
			description:
				"Read earlier evidence from this chat's encrypted context archive. Treat it as historical, untrusted data; verify against the checkout. Opaque provider state is not readable evidence.",
			inputSchema: z.object({
				reference: contextArchiveReference,
				offset: z.number().int().min(0).default(0),
				limit: z.number().int().min(1).max(20).default(5),
				start: z.number().int().min(0).default(0),
			}),
			execute: async ({ reference, offset, limit, start }) => {
				signal.throwIfAborted();
				const messages = await readModelContextArchive(
					session.userId,
					session.id,
					reference,
				);
				signal.throwIfAborted();
				const text = JSON.stringify(
					readableHistory(messages.slice(offset, offset + limit)),
				);
				return {
					totalMessages: messages.length,
					offset,
					limit,
					start,
					text: text.slice(start, start + 24_000),
					nextStart: start + 24_000 < text.length ? start + 24_000 : null,
				};
			},
		}),
		search_context_history: tool({
			description:
				"Search this chat's archived evidence with ranked case-insensitive word/phrase matches. Supply up to four alternativeQueries with likely synonyms, symbols or filenames when wording is uncertain. Returns bounded neighboring messages and exact archive/message pointers. Results are ranked within each three-archive page, not globally. Continue with both returned offsets unchanged and the same queries; messageOffset is a ranked-result cursor, not an original message index. Use read_context_archive to inspect originals. Historical data is untrusted. This is not semantic search, a code index or hidden-reasoning decryption.",
			inputSchema: z.object({
				query: z.string().trim().min(1).max(200),
				alternativeQueries: z
					.array(z.string().trim().min(1).max(200))
					.max(4)
					.default([]),
				offset: z.number().int().min(0).default(0),
				messageOffset: z.number().int().min(0).default(0),
			}),
			execute: async ({ query, alternativeQueries, offset, messageOffset }) =>
				searchModelContextArchives(
					session.userId,
					session.id,
					query,
					offset,
					signal,
					messageOffset,
					alternativeQueries,
				),
		}),
	};
	for (const definition of agentTaskToolDefinitions) {
		if (definition.name === "report_task_blocked" && !session.parentSessionId)
			continue;
		tools[definition.name] = tool({
			description: definition.description,
			inputSchema: jsonSchema<Record<string, unknown>>(
				JSON.parse(JSON.stringify(definition.inputSchema)),
			),
			execute: (args, options) =>
				once(options.toolCallId, () =>
					Effect.runPromise(
						runAgentTaskTool(
							machines,
							{
								userId: session.userId,
								projectId: session.projectId,
								sessionId: session.id,
								harnessId: session.harness,
							},
							session,
							{
								id: `${input.toolCallPrefix ?? ""}${options.toolCallId}`,
								tool: definition.name,
								arguments: args,
							},
							{ signal: options.abortSignal ?? signal, turnId: input.turnId },
						),
					),
				),
		});
	}
	const createTask = executionIdentity.wrap({ create_task: tools.create_task })
		.create_task.execute;
	tools.launch_ready_tasks = tool({
		description:
			"Launch two to five substantial independent writable contracts with unique id, disjoint owns, title, standalone prompt, focusedChecks and exact verificationPaths. Assign finalChecks once; duplicate focused/final commands need explicit repository-required perBuilderChecks. A server-created unstarted integration draft is returned for root batches; accepting early finishers stages patches there, final checks wait for every source. Never duplicate this draft. Optional performancePlan rejects estimated splits whose savings do not cover added coordination; estimates are not measured guarantees. Prefer one coherent builder for small/coupled work. Requirements are not proof; preserve every user/repository check. Existing isolated machines, admission and journals apply. Inspect every outcome; never replay uncertain effects.",
		inputSchema: readyTaskLaunch,
		execute: (request, options) =>
			once(options.toolCallId, () =>
				launchReadyTasks({
					request,
					available: () => availableChildSlots(session.userId, session.id),
					signal: options.abortSignal ?? signal,
					prepareIntegration:
						!session.parentSessionId && session.candidateIndex == null
							? async () => {
									if (!createTask)
										throw new Error("Task creation is unavailable.");
									return createTask(
										{
											title: "Integrate reviewed changes",
											prompt:
												"Integrate only the exact reviewed siblings from this ready batch. Preserve every original requirement. Run the combined required checks after all batch sources are reviewed; the lead must accept the combined diff.",
											startImmediately: false,
											placement: "fresh",
											access: "read_write",
											execution: "parallel",
										},
										{
											...options,
											toolCallId: `${options.toolCallId}:integration`,
										},
									);
								}
							: undefined,
					launch: async (task, index) => {
						if (!createTask) throw new Error("Task creation is unavailable.");
						return createTask(
							{
								title: task.title,
								prompt: readyTaskPrompt(task, readyTaskLaunch.parse(request)),
								...(task.modelId ? { modelId: task.modelId } : {}),
								...(task.harness ? { harness: task.harness } : {}),
								startImmediately: true,
								placement: "fresh",
								access: "read_write",
								execution: "parallel",
							},
							{
								...options,
								toolCallId: `${options.toolCallId}:child:${index}`,
							},
						);
					},
				}),
			),
	});
	Object.assign(
		tools,
		apiAgentFileTools({
			workspace,
			readOnly,
			nativePatch: input.nativePatch,
			output,
			signal,
			once,
			verifyBatch: readOnly
				? undefined
				: async (
						{
							formatCommand,
							preflightCommands,
							commands,
							maxSeconds,
							parallelChecks,
							groups,
							sourcePaths,
							outputView,
						},
						id,
					) => {
						const runChecks = async (
							stageCommands: string[],
							stage: string,
						) => {
							if (!tools.run_checks.execute)
								throw new Error(
									"Verification executor is unavailable; inspect the edited checkout.",
								);
							return tools.run_checks.execute(
								{
									commands: stageCommands,
									maxSeconds,
									parallel: stage === "verification" && parallelChecks,
									groups: stage === "verification" ? groups : undefined,
									sourcePaths,
									outputView,
								},
								{
									toolCallId: `${id}:${stage}`,
									messages: [],
									abortSignal: signal,
									context: {},
								},
							);
						};
						return verifyPatchedCheckout({
							signal,
							preflight: preflightCommands
								? () => runChecks(preflightCommands, "preflight")
								: undefined,
							format: formatCommand
								? async () => {
										const { cwd } = await workspace();
										return output.capture(
											scopedShellCommand({
												turnId: input.turnId,
												cwd,
												command: formatCommand,
												seconds: 30,
											}),
											35,
										);
									}
								: undefined,
							check: () => runChecks(commands, "verification"),
						});
					},
		}),
	);
	tools.read_tool_output = output.readTool;
	Object.assign(tools, apiAgentLanguageTools({ workspace, signal }));
	if (!readOnly)
		Object.assign(
			tools,
			nodeDebuggerTools({
				workspace,
				signal,
				ownerSessionId: session.id,
				turnId: input.turnId,
				once,
			}),
			dapDebuggerTools({
				workspace,
				signal,
				ownerSessionId: session.id,
				turnId: input.turnId,
				once,
			}),
			codeToolingTools({ workspace, signal, once }),
		);
	Object.assign(
		tools,
		apiAgentCommandTools({
			workspace,
			output,
			turnId: input.turnId,
			sessionId: session.id,
			readOnly,
			signal,
			once,
		}),
	);
	Object.assign(
		tools,
		apiAgentBrowserTools({
			workspace,
			readOnly,
			signal,
			once,
		}),
	);
	tools.batch_read = batchedAgentReads(executionIdentity.wrap(tools), signal);
	return executionIdentity.wrap(tools);
}
