import { jsonSchema, type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { agentTaskToolDefinitions } from "#/domain/agent-task-definitions";
import { WorkspaceId } from "#/domain/ids";
import { knowledgeForTask } from "#/domain/project-knowledge";
import {
	cachedSourceEvidence,
	sourceEvidenceMatches,
} from "#/domain/project-source-evidence";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { agentContextArchiveTools } from "./agent-context-archive-tools";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { apiAgentBrowserTools } from "./api-agent-browser-tools";
import {
	apiAgentCommandTools,
	verifyPatchedCheckout,
} from "./api-agent-command-tools";
import { apiAgentFileTools } from "./api-agent-file-tools";
import { apiAgentLanguageTools } from "./api-agent-language-tools";
import { apiAgentSearchTools } from "./api-agent-search-tools";
import { scopedShellCommand } from "./api-command-scope";
import { batchedAgentReads } from "./batched-agent-reads";
import { codeToolingTools } from "./code-tooling";
import { dapDebuggerTools } from "./dap-debugger";
import { runAgentTaskTool } from "./harness-workspace-session";
import { journaledToolOperation } from "./journaled-tool-operation";
import { nodeDebuggerTools } from "./node-debugger";
import { loadCloudProjectMemoryDocument } from "./project-knowledge";
import { projectMemoryTools } from "./project-memory-tools";
import { inspectProjectSourceEvidence } from "./project-source-evidence";
import { repositoryGuidanceTool } from "./repository-guidance";
import { scopedToolExecution } from "./tool-execution-identity";
import type { WorkspaceMachines } from "./workspace-machines";

export function apiAgentTools(
	input: {
		machines: WorkspaceMachines;
		session: AgentSessionRecord;
		turnId: string;
		toolCallPrefix?: string;
		nativePatch?: boolean;
		signal: AbortSignal;
		/** A builder-direct root chat edits its own workspace. */
		writable?: boolean;
		/** Latest epoch ms a command wait may end (step budget or turn deadline minus a margin). */
		waitDeadlineAt?: number;
	} & ({ cwd: string } | { workspace: () => Promise<AgentToolWorkspace> }),
): ToolSet {
	const { machines, session, signal } = input;
	const executionIdentity = scopedToolExecution();
	const readOnly =
		!input.writable &&
		(!session.parentSessionId || session.taskAccess !== "read_write");
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
		...apiAgentSearchTools({ workspace, signal, output }),
		...agentContextArchiveTools({
			userId: session.userId,
			sessionId: session.id,
			signal,
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
			waitDeadlineAt: input.waitDeadlineAt,
		}),
	);
	Object.assign(
		tools,
		apiAgentBrowserTools({
			workspace,
			readOnly,
			sessionId: session.id,
			executeCommand: tools.execute_command?.execute,
			signal,
			once,
		}),
	);
	tools.batch_read = batchedAgentReads(executionIdentity.wrap(tools), signal);
	return executionIdentity.wrap(tools);
}
