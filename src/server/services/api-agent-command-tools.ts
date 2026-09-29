import { randomUUID } from "node:crypto";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "./workspace-machines";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const jobId = z.string().uuid();

export function apiAgentCommandTools(input: {
	machines: WorkspaceMachines;
	vm: WorkspaceId;
	cwd: string;
	sessionId: string;
	readOnly: boolean;
	signal: AbortSignal;
	once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
}): ToolSet {
	const { machines, vm, cwd, signal, once } = input;
	const root = `/tmp/ytimesy-api-commands/${input.sessionId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64)}`;
	const paths = (id: string) => ({
		output: `${root}/${id}.output`,
		status: `${root}/${id}.status`,
		session: `ytimesy-${id.replaceAll("-", "")}`,
	});
	const tools: ToolSet = {
		read_command: tool({
			description:
				"Read the latest output and status of a long-running command started in this agent session.",
			inputSchema: z.object({ id: jobId }),
			execute: async ({ id }) => {
				signal.throwIfAborted();
				const path = paths(id);
				const result = await machines.exec(
					vm,
					`test -f ${quote(path.output)} || exit 2; if test -f ${quote(path.status)}; then printf 'STATUS='; cat ${quote(path.status)}; elif tmux -L ytimesy-api has-session -t ${quote(path.session)} 2>/dev/null; then printf 'STATUS=running\\n'; else printf 'STATUS=interrupted\\n'; fi; printf '\\nOUTPUT\\n'; tail -c 32000 ${quote(path.output)}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error("Command was not found in this agent session.");
				return result.stdout;
			},
		}),
	};
	if (input.readOnly) return tools;
	tools.start_command = tool({
		description:
			"Start a repository command that may take several minutes. Returns an ID; use read_command to inspect output and completion. Bounded to ten minutes.",
		inputSchema: z.object({
			command: z.string().min(1).max(16_000),
			maxSeconds: z.number().int().min(30).max(600).default(300),
		}),
		execute: ({ command, maxSeconds }, options) =>
			once(options.toolCallId, async () => {
				signal.throwIfAborted();
				const id = randomUUID();
				const path = paths(id);
				const job = `cd ${quote(cwd)} && timeout --kill-after=5s ${maxSeconds}s bash -lc ${quote(command)} >${quote(path.output)} 2>&1; printf '%s\\n' "$?" >${quote(path.status)}`;
				const result = await machines.exec(
					vm,
					`mkdir -p ${quote(root)} && : >${quote(path.output)} && tmux -L ytimesy-api new-session -d -s ${quote(path.session)} bash -lc ${quote(job)}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error("Could not start long-running command.");
				return { id, status: "running" };
			}),
	});
	tools.stop_command = tool({
		description: "Stop a long-running command owned by this agent session.",
		inputSchema: z.object({ id: jobId }),
		execute: ({ id }, options) =>
			once(options.toolCallId, async () => {
				signal.throwIfAborted();
				const path = paths(id);
				const result = await machines.exec(
					vm,
					`test -f ${quote(path.output)} || exit 2; tmux -L ytimesy-api kill-session -t ${quote(path.session)} 2>/dev/null || true; test -f ${quote(path.status)} || printf '130\\n' >${quote(path.status)}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error("Command was not found in this agent session.");
				return { id, status: "stopped" };
			}),
	});
	return tools;
}
