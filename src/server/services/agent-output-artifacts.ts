import { createHash, randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export const agentOutputPageSchema = z.object({
	reference: z.uuid(),
	stream: z.enum(["stdout", "stderr"]).default("stdout"),
	start: z.number().int().min(0).max(32_000_000).default(0),
});
const PAGE_SCRIPT = `import json, os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
if root.is_symlink():
    raise ValueError('Artifact root cannot be a symlink')
reference, stream, start = sys.argv[2], sys.argv[3], int(sys.argv[4])
descriptor = os.open(root / (reference + '.' + stream), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(descriptor, 'r', encoding='utf-8', errors='replace') as handle:
    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
        raise ValueError('Artifact must be a regular file')
    handle.read(start)
    content = handle.read(32001)
print(json.dumps({'reference': reference, 'stream': stream, 'start': start, 'content': content[:32000], 'nextStart': start + 32000 if len(content) > 32000 else None}, ensure_ascii=False))`;

const CAPTURE_SCRIPT = `import json, os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
root.mkdir(mode=0o700, exist_ok=True)
if root.is_symlink():
    raise ValueError('Artifact root cannot be a symlink')
reference, command, timeout = sys.argv[2], sys.argv[3], int(sys.argv[4])
merge = len(sys.argv) > 5 and sys.argv[5] == '1'
handles = []
try:
    for stream in ('stdout', 'stderr'):
        descriptor = os.open(root / (reference + '.' + stream), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        handles.append(os.fdopen(descriptor, 'wb'))
    process = subprocess.Popen(command, shell=True, stdout=handles[0], stderr=handles[0] if merge else handles[1], start_new_session=True)
    deadline = time.monotonic() + timeout
    stopped = None
    try:
        while process.poll() is None:
            if time.monotonic() >= deadline:
                stopped = 'timeout'
                break
            if any(os.fstat(handle.fileno()).st_size > 16777216 for handle in handles):
                stopped = 'output_limit'
                break
            time.sleep(0.05)
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            grace = time.monotonic() + 2.5
            while time.monotonic() < grace:
                process.poll()
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
    for handle in handles:
        handle.close()
    output = {'reference': reference, 'exitCode': process.returncode, 'stopped': stopped}
    for stream in ('stdout', 'stderr'):
        path = root / (reference + '.' + stream)
        if path.stat().st_size > 16777216:
            stopped = 'output_limit'
            with path.open('r+b') as handle:
                handle.truncate(16777216)
        with path.open(encoding='utf-8', errors='replace') as handle:
            content = handle.read(32001)
        output[stream] = content[:32000]
        output[stream + 'NextStart'] = 32000 if len(content) > 32000 else None
    output['stopped'] = stopped
    if stopped:
        output['exitCode'] = 124 if stopped == 'timeout' else 125
    print(json.dumps(output, ensure_ascii=False))
finally:
    for handle in handles:
        handle.close()`;

export type AgentOutput = {
	reference: string;
	exitCode: number;
	stopped: "timeout" | "output_limit" | null;
	stdout: string;
	stderr: string;
	stdoutNextStart: number | null;
	stderrNextStart: number | null;
};

/** Guest-local, session-scoped evidence; never accepts an arbitrary host path. */
export function agentOutputArtifacts(
	input: AgentToolWorkspaceInput & { sessionId: string; signal: AbortSignal },
) {
	const directory = `/tmp/ytimesy-output-${createHash("sha256").update(input.sessionId).digest("hex")}`;
	const captureCommand = (
		command: string,
		timeoutSeconds: number,
		reference: string,
		mergeOutput = false,
	) =>
		`python3 -c ${quote(CAPTURE_SCRIPT)} ${quote(directory)} ${quote(reference)} ${quote(command)} ${timeoutSeconds} ${mergeOutput ? 1 : 0}`;
	const read = async (page: z.input<typeof agentOutputPageSchema>) => {
		input.signal.throwIfAborted();
		const parsed = agentOutputPageSchema.parse(page);
		const { machines, vm } = await resolveToolWorkspace(input);
		const result = await machines.exec(
			vm,
			`python3 -c ${quote(PAGE_SCRIPT)} ${quote(directory)} ${quote(parsed.reference)} ${parsed.stream} ${parsed.start}`,
			15_000,
		);
		if (result.exitCode)
			throw new Error("Output reference is unavailable in this session.");
		return JSON.parse(result.stdout) as {
			reference: string;
			stream: string;
			start: number;
			content: string;
			nextStart: number | null;
		};
	};
	return {
		directory,
		captureCommand,
		read,
		async capture(command: string, timeoutSeconds = 20): Promise<AgentOutput> {
			input.signal.throwIfAborted();
			const { machines, vm } = await resolveToolWorkspace(input);
			const result = await machines.exec(
				vm,
				captureCommand(command, timeoutSeconds, randomUUID()),
				(timeoutSeconds + 5) * 1000,
			);
			if (result.exitCode)
				throw new Error("Could not capture tool output safely.");
			return JSON.parse(result.stdout) as AgentOutput;
		},
		readTool: tool({
			description:
				"Retrieve complete retained output from a tool's reference. Follow nextStart until null. Artifacts belong to this session and remain available while its VM exists. A stopped:output_limit result means execution was stopped and retained output is incomplete; do not treat it as complete evidence.",
			inputSchema: agentOutputPageSchema,
			execute: read,
		}),
	};
}
