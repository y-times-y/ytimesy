import { z } from "zod";
import type { BackgroundCommandExit } from "#/domain/background-command";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { agentOutputDirectory } from "./agent-output-artifacts";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { COMMAND_TMUX_SOCKET, commandRoot } from "./api-agent-command-tools";

/**
 * The machine side of background commands (background-command.ts): the
 * launch writes `<id>.background` (label, start) beside the command's status
 * in the session's command root, and `<id>.notified` says who learnt of its
 * exit ("agent" or "notice"; background-command-notices.ts). These reads need
 * only the machine, no database, so the Harbor bridge uses them too.
 */

/** Built on use: test module mocks of the command tools need not export the socket. */
const observeScript = () => `import json, os, pathlib, subprocess, sys, time
root, outputs, claim = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3] == '1'
ids = json.loads(sys.argv[4])
results = []
def tail(path):
    try:
        with open(path, 'rb') as handle:
            handle.seek(0, 2); size = handle.tell(); handle.seek(max(0, size - 4000))
            text = handle.read().decode('utf-8', 'replace')
    except OSError:
        return ''
    return '\\n'.join(text.splitlines()[-20:])
for identifier in ids:
    meta = root / (identifier + '.background')
    if root.is_symlink() or not meta.is_file():
        continue
    try:
        record = json.loads(meta.read_text())
    except ValueError:
        continue
    status = root / (identifier + '.status')
    stopped = None
    if status.is_file():
        raw = status.read_text().strip()
        try:
            parsed = json.loads(raw) if raw.startswith('{') else {'exitCode': int(raw), 'stopped': None}
            code, stopped = parsed['exitCode'], parsed.get('stopped')
        except (ValueError, KeyError):
            code = 'interrupted'
        ended = int(status.stat().st_mtime * 1000)
    elif subprocess.run(['tmux', '-L', '${COMMAND_TMUX_SOCKET}', 'has-session', '-t', 'ytimesy-' + identifier.replace('-', '')], capture_output=True).returncode == 0:
        results.append({'id': identifier, 'running': True, 'startedAt': int(record.get('startedAt') or 0)})
        continue
    else:
        code, ended = 'interrupted', int(time.time() * 1000)
    notified = root / (identifier + '.notified')
    fresh = False
    if not notified.exists() and claim:
        try:
            os.close(os.open(notified, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
            notified.write_text('notice'); fresh = True
        except FileExistsError:
            pass
    if not notified.exists():
        continue
    try:
        by = notified.read_text().strip() or 'notice'
    except OSError:
        by = 'notice'
    output = outputs / (identifier + '.stdout')
    if not output.is_file():
        output = root / (identifier + '.output')
    results.append({'id': identifier, 'running': False, 'label': str(record.get('label') or 'command')[:80], 'startedAt': int(record.get('startedAt') or ended), 'endedAt': ended, 'exitCode': code, 'stopped': stopped, 'announced': by == 'notice', 'fresh': fresh, 'outputPath': str(output), 'lastLines': tail(output) if by == 'notice' else ''})
print(json.dumps(results))`;

const observation = z.array(
	z.union([
		z.object({
			id: z.uuid(),
			running: z.literal(true),
			startedAt: z.number().optional(),
		}),
		z.object({
			id: z.uuid(),
			running: z.literal(false),
			label: z.string(),
			startedAt: z.number(),
			endedAt: z.number(),
			exitCode: z.union([z.number().int(), z.literal("interrupted")]),
			stopped: z.enum(["timeout", "output_limit"]).nullable(),
			announced: z.boolean(),
			fresh: z.boolean(),
			outputPath: z.string(),
			lastLines: z.string(),
		}),
	]),
);

export type ObservedBackgroundExit = BackgroundCommandExit & {
	/** The agent did not stop or see it finish itself: it gets (or got) a notice. */
	readonly announced: boolean;
	/** This observation claimed its notice: the caller delivers it. */
	readonly fresh: boolean;
};

/**
 * One guest observation of the given background commands: those still
 * running (with their start) and those that exited. With `claim`, an exit
 * nobody learnt of yet is claimed for a notice (fresh); without it such exits
 * are left for whoever claims them and not reported.
 */
export async function observeBackgroundCommandStates(
	input: AgentToolWorkspaceInput & {
		sessionId: string;
		ids: readonly string[];
		claim: boolean;
	},
): Promise<{
	running: { id: string; startedAt: number | null }[];
	exits: ObservedBackgroundExit[];
}> {
	const ids = z.array(z.uuid()).max(20).parse(input.ids);
	if (!ids.length) return { running: [], exits: [] };
	const { machines, vm } = await resolveToolWorkspace(input);
	const result = await machines.exec(
		vm,
		`python3 -c ${quote(observeScript())} ${quote(commandRoot(input.sessionId))} ${quote(agentOutputDirectory(input.sessionId))} ${input.claim ? 1 : 0} ${quote(JSON.stringify(ids))}`,
		15_000,
	);
	if (result.exitCode)
		throw new Error("Could not observe background commands.");
	const entries = observation.parse(JSON.parse(result.stdout));
	return {
		running: entries.flatMap((entry) =>
			entry.running
				? [{ id: entry.id, startedAt: entry.startedAt || null }]
				: [],
		),
		exits: entries.flatMap((entry) => (entry.running ? [] : [entry])),
	};
}

/**
 * One guest observation of the given background commands. With `claim`, an
 * exit nobody learnt of yet is claimed for a notice (fresh); without it such
 * exits are left for whoever claims them and not reported.
 */
export async function observeBackgroundCommands(
	input: AgentToolWorkspaceInput & {
		sessionId: string;
		ids: readonly string[];
		claim: boolean;
	},
): Promise<ObservedBackgroundExit[]> {
	return (await observeBackgroundCommandStates(input)).exits;
}

const UNNOTIFIED_SCRIPT = `import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
found = []
if root.is_dir() and not root.is_symlink():
    for meta in root.glob('*.background'):
        identifier = meta.name[:-len('.background')]
        if not (root / (identifier + '.notified')).exists():
            found.append((meta.stat().st_mtime, identifier))
print(json.dumps([identifier for _, identifier in sorted(found)][-20:]))`;

/**
 * The background commands a session launched whose exit nobody learnt of yet
 * (still running, or exited without a notice), read from the machine's own
 * records (`<id>.background` without `<id>.notified`), the newest 20, oldest
 * first. For callers without the session's timeline (the Harbor bridge).
 */
export async function unnotifiedBackgroundCommandIds(
	input: AgentToolWorkspaceInput & { sessionId: string },
): Promise<string[]> {
	const { machines, vm } = await resolveToolWorkspace(input);
	const result = await machines.exec(
		vm,
		`python3 -c ${quote(UNNOTIFIED_SCRIPT)} ${quote(commandRoot(input.sessionId))}`,
		15_000,
	);
	if (result.exitCode) throw new Error("Could not list background commands.");
	return z
		.array(z.string())
		.parse(JSON.parse(result.stdout))
		.filter((id) => z.uuid().safeParse(id).success);
}
