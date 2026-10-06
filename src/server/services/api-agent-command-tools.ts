import { randomUUID } from "node:crypto";
import { type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import type { agentOutputArtifacts } from "./agent-output-artifacts";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { scopedShellCommand } from "./api-command-scope";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const jobId = z.string().uuid();

/** Formatting must finish successfully before any checks observe the edited checkout. */
export async function verifyPatchedCheckout(input: {
	signal: AbortSignal;
	format?: () => Promise<
		Awaited<ReturnType<ReturnType<typeof agentOutputArtifacts>["capture"]>>
	>;
	check: () => Promise<unknown>;
}) {
	input.signal.throwIfAborted();
	const formatting = input.format ? await input.format() : null;
	if (formatting && (formatting.exitCode !== 0 || formatting.stopped !== null))
		return { formatting, checks: null };
	input.signal.throwIfAborted();
	return { formatting, checks: await input.check() };
}
const commandRoot = (sessionId: string) =>
	`/tmp/ytimesy-api-commands/${sessionId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64)}`;

const COMPLETIONS_SCRIPT = `import json, os, pathlib, stat, subprocess, sys
root = pathlib.Path(sys.argv[1])
if root.is_symlink():
    raise ValueError('Command root cannot be a symlink')
results = []
for identifier in json.loads(sys.argv[2]):
    path = root / (identifier + '.status')
    if not path.exists():
        active = subprocess.run(['tmux', '-L', 'ytimesy-api', 'has-session', '-t', 'ytimesy-' + identifier.replace('-', '')], capture_output=True).returncode == 0
        if not active:
            results.append({'id': identifier, 'status': 'interrupted', 'stopped': None})
        continue
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, encoding='utf-8') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError('Status must be a regular file')
        raw = handle.read(1000001).strip()
    result = json.loads(raw) if raw.startswith('{') else {'exitCode': int(raw), 'stopped': None}
    results.append({'id': identifier, 'status': result['exitCode'], 'stopped': result['stopped']})
print(json.dumps(results))`;

/** One bounded guest observation at a runtime safe point; no model polling or arbitrary paths. */
export async function completedAgentCommands(
	input: AgentToolWorkspaceInput & {
		sessionId: string;
		ids: readonly string[];
		signal: AbortSignal;
	},
) {
	input.signal.throwIfAborted();
	const ids = z.array(jobId).max(20).parse(input.ids);
	if (!ids.length) return [];
	const { machines, vm } = await resolveToolWorkspace(input);
	const result = await machines.exec(
		vm,
		`python3 -c ${quote(COMPLETIONS_SCRIPT)} ${quote(commandRoot(input.sessionId))} ${quote(JSON.stringify(ids))}`,
		15_000,
	);
	if (result.exitCode)
		throw new Error("Could not observe owned command completion safely.");
	return z
		.array(
			z.object({
				id: jobId,
				status: z.union([z.number().int(), z.literal("interrupted")]),
				stopped: z.enum(["timeout", "output_limit"]).nullable(),
			}),
		)
		.parse(JSON.parse(result.stdout));
}
const READ_COMMAND_SCRIPT = `import json, os, pathlib, stat, subprocess, sys, time
output, status, session, start, seconds = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
if not 0 <= start <= 100000000 or not 0 <= seconds <= 55:
    raise ValueError('Command page or wait is outside the supported range')
deadline = time.monotonic() + seconds
while not pathlib.Path(status).exists() and time.monotonic() < deadline:
    if subprocess.run(['tmux', '-L', 'ytimesy-api', 'has-session', '-t', session], capture_output=True).returncode:
        break
    time.sleep(0.25)
state = 'interrupted'
stopped = None
if pathlib.Path(status).exists():
    descriptor = os.open(status, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, encoding='utf-8') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError('Status must be a regular file')
        raw = handle.read(1000001).strip()
        if raw.startswith('{'):
            result = json.loads(raw)
            state, stopped = result['exitCode'], result['stopped']
        else:
            state = int(raw)
elif subprocess.run(['tmux', '-L', 'ytimesy-api', 'has-session', '-t', session], capture_output=True).returncode == 0:
    state = 'running'
if len(sys.argv) > 6 and pathlib.Path(sys.argv[6]).exists():
    output = sys.argv[6]
if seconds > 0 and state == 'running':
    print(json.dumps({'status': state, 'stopped': stopped, 'stdout': '', 'start': start, 'nextStart': start, 'outputDeferred': True}))
    sys.exit(0)
descriptor = os.open(output, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(descriptor, encoding='utf-8', errors='replace') as handle:
    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
        raise ValueError('Output must be a regular file')
    handle.read(start)
    text = handle.read(32001)
print(json.dumps({'status': state, 'stopped': stopped, 'stdout': text[:32000], 'start': start, 'nextStart': start + 32000 if len(text) > 32000 else None}, ensure_ascii=False))`;

export function apiAgentCommandTools(
	input: AgentToolWorkspaceInput & {
		sessionId: string;
		turnId: string;
		readOnly: boolean;
		signal: AbortSignal;
		once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
		output?: ReturnType<typeof agentOutputArtifacts>;
	},
): ToolSet {
	const { signal, once } = input;
	const root = commandRoot(input.sessionId);
	const paths = (id: string) => ({
		output: `${root}/${id}.output`,
		status: `${root}/${id}.status`,
		session: `ytimesy-${id.replaceAll("-", "")}`,
	});
	const readCommand = async (id: string, start = 0, seconds = 0) => {
		signal.throwIfAborted();
		jobId.parse(id);
		const { machines, vm } = await resolveToolWorkspace(input);
		const path = paths(id);
		const result = await machines.exec(
			vm,
			`python3 -c ${quote(READ_COMMAND_SCRIPT)} ${quote(path.output)} ${quote(path.status)} ${quote(path.session)} ${start} ${seconds}${input.output ? ` ${quote(`${input.output.directory}/${id}.stdout`)}` : ""}`,
			(seconds + 5) * 1000,
		);
		if (result.exitCode)
			throw new Error("Command was not found in this agent session.");
		return JSON.parse(result.stdout) as {
			status: number | "running" | "interrupted";
			stdout: string;
			start: number;
			nextStart: number | null;
		};
	};
	const tools: ToolSet = {
		read_command: tool({
			description:
				"Read status and a complete-output page of a command owned by this session. Follow nextStart to retrieve earlier/later evidence; a null cursor while running is only the current end, not proof of completion.",
			inputSchema: z.object({
				id: jobId,
				start: z.number().int().min(0).max(100_000_000).default(0),
			}),
			execute: ({ id, start = 0 }) => readCommand(id, start),
		}),
	};
	if (input.readOnly) return tools;
	if (input.output) {
		const output = input.output;
		const checksSchema = z.object({
			commands: z.array(z.string().min(1).max(16_000)).min(1).max(8),
			maxSeconds: z.number().int().min(1).max(120).default(120),
		});
		tools.run_checks = tool({
			description:
				"Run independent verification commands for a stable checkout in one call, with at most two running concurrently. Returns each command's actual exit code, stop reason, retained output reference and continuation cursors in input order. Never omit required project checks. A zero exit with no stop is success; timeout/output-limit is not. Read incomplete output through read_tool_output. Do not mix edits or formatting commands with checks, or edit the tree while checks run. Prefer this over separate start/wait/read polling steps for checks within two minutes.",
			inputSchema: checksSchema,
			execute: (arguments_, options) =>
				once(options.toolCallId, async () => {
					const { commands, maxSeconds } = checksSchema.parse(arguments_);
					signal.throwIfAborted();
					const { cwd } = await resolveToolWorkspace(input);
					return Effect.runPromise(
						Effect.forEach(
							commands,
							(command) =>
								Effect.promise(async () => {
									signal.throwIfAborted();
									const result = await output.capture(
										scopedShellCommand({
											turnId: input.turnId,
											cwd,
											command,
											seconds: maxSeconds,
										}),
										maxSeconds + 5,
									);
									return {
										command,
										...result,
										passed: result.exitCode === 0 && result.stopped === null,
									};
								}),
							{ concurrency: 2 },
						),
					);
				}),
		});
	}
	tools.wait_command = tool({
		description:
			"Wait for an owned command to finish without repeated model polling. Bounded to 55 seconds; if still running, output is deferred with an unchanged cursor, not discarded. Use read_command to inspect live progress if needed. Inspect completion status and all output pages before claiming checks passed. Does not start or stop commands.",
		inputSchema: z.object({
			id: jobId,
			start: z.number().int().min(0).max(100_000_000).default(0),
			seconds: z.number().int().min(1).max(55).default(10),
		}),
		execute: ({ id, start = 0, seconds = 10 }) =>
			readCommand(id, start, seconds),
	});
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
				const { machines, vm, cwd } = await resolveToolWorkspace(input);
				const id = randomUUID();
				const path = paths(id);
				const scoped = scopedShellCommand({
					turnId: input.turnId,
					cwd,
					command,
					seconds: maxSeconds,
				});
				const job = input.output
					? `${input.output.captureCommand(scoped, maxSeconds, id, true)} >${quote(`${path.status}.pending`)} && mv ${quote(`${path.status}.pending`)} ${quote(path.status)}`
					: `${scoped} >${quote(path.output)} 2>&1; printf '%s\\n' "$?" >${quote(path.status)}`;
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
				const { machines, vm } = await resolveToolWorkspace(input);
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
