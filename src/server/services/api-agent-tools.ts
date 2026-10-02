import { jsonSchema, type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { agentTaskToolDefinitions } from "#/domain/agent-task-definitions";
import { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	claimAgentTaskCommand,
	completeAgentTaskCommand,
	renewAgentTaskCommandClaim,
} from "../adapters/agent-task-command-receipts";
import { apiAgentBrowserTools } from "./api-agent-browser-tools";
import { apiAgentCommandTools } from "./api-agent-command-tools";
import { apiAgentFileTools } from "./api-agent-file-tools";
import { runAgentTaskTool } from "./harness-workspace-session";
import type { WorkspaceMachines } from "./workspace-machines";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function apiAgentTools(input: {
	machines: WorkspaceMachines;
	session: AgentSessionRecord;
	cwd: string;
	turnId: string;
	signal: AbortSignal;
}): ToolSet {
	const { machines, session, cwd, signal } = input;
	if (!session.providerRef) throw new Error("Task workspace is unavailable.");
	const vm = WorkspaceId(session.providerRef);
	async function once(id: string, run: () => Promise<unknown>) {
		signal.throwIfAborted();
		const requestId = `${input.turnId}:${id}`;
		const receipt = await claimAgentTaskCommand(session.id, requestId);
		if (receipt.kind === "done") {
			if (!receipt.response.ok)
				throw new Error("The recorded tool call failed.");
			return receipt.response.result;
		}
		if (receipt.kind === "processing")
			throw new Error(
				"Tool outcome is uncertain; inspect the workspace before retrying.",
			);
		const heartbeat = setInterval(
			() =>
				void renewAgentTaskCommandClaim(session.id, requestId).catch(() => {}),
			10_000,
		);
		try {
			const result = await run();
			await completeAgentTaskCommand(session.id, {
				id: requestId,
				ok: true,
				result,
			});
			return result;
		} finally {
			clearInterval(heartbeat);
		}
	}
	const tools: ToolSet = {
		list_files: tool({
			description:
				"List tracked and untracked repository files before choosing what to inspect.",
			inputSchema: z.object({}),
			execute: async () => {
				signal.throwIfAborted();
				const result = await machines.exec(
					vm,
					`git -C ${quote(cwd)} ls-files --cached --others --exclude-standard`,
					15_000,
				);
				if (result.exitCode)
					throw new Error("Could not list repository files.");
				return result.stdout.slice(0, 32_000);
			},
		}),
		search_files: tool({
			description:
				"Search tracked repository text without changing the workspace.",
			inputSchema: z.object({ query: z.string().min(1).max(200) }),
			execute: async ({ query }) => {
				signal.throwIfAborted();
				const result = await machines.exec(
					vm,
					`git -C ${quote(cwd)} grep -n -I -m 5 -e ${quote(query)} -- .`,
					15_000,
				);
				if (result.exitCode > 1)
					throw new Error("Could not search repository files.");
				return result.stdout.slice(0, 32_000);
			},
		}),
		read_file: tool({
			description:
				"Read a UTF-8 file inside the repository. Output is bounded.",
			inputSchema: z.object({ path: z.string().max(2048) }),
			execute: async ({ path }) => {
				signal.throwIfAborted();
				const script = `import pathlib\nr=pathlib.Path(${JSON.stringify(cwd)}).resolve()\np=(r/${JSON.stringify(path)}).resolve()\nif not p.is_relative_to(r): raise ValueError('Path outside repository')\nwith p.open('r') as f: print(f.read(32000))`;
				const result = await machines.exec(
					vm,
					`python3 -c ${quote(script)}`,
					15_000,
				);
				if (result.exitCode) throw new Error("Could not read repository file.");
				return result.stdout;
			},
		}),
	};
	if (session.taskAccess !== "read_only") {
		tools.bash = tool({
			description:
				"Run a shell command in this task's isolated repository. Do not publish changes unless authorized. Commands are bounded to 30 seconds; do not launch detached work.",
			inputSchema: z.object({ command: z.string().min(1).max(16000) }),
			execute: ({ command }, options) =>
				once(options.toolCallId, async () => {
					const result = await machines.exec(
						vm,
						`cd ${quote(cwd)} && timeout --kill-after=2s 30s bash -lc ${quote(command)}`,
						35_000,
					);
					return {
						...result,
						stdout: result.stdout.slice(0, 32000),
						stderr: result.stderr.slice(0, 8000),
					};
				}),
		});
	}
	for (const definition of agentTaskToolDefinitions) {
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
								id: options.toolCallId,
								tool: definition.name,
								arguments: args,
							},
						),
					),
				),
		});
	}
	Object.assign(
		tools,
		apiAgentFileTools({
			machines,
			vm,
			cwd,
			readOnly: session.taskAccess === "read_only",
			signal,
			once,
		}),
	);
	Object.assign(
		tools,
		apiAgentCommandTools({
			machines,
			vm,
			cwd,
			sessionId: session.id,
			readOnly: session.taskAccess === "read_only",
			signal,
			once,
		}),
	);
	Object.assign(
		tools,
		apiAgentBrowserTools({
			machines,
			vm,
			readOnly: session.taskAccess === "read_only",
			signal,
			once,
		}),
	);
	return tools;
}
