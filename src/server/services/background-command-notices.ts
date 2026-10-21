import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import { z } from "zod";
import {
	type BackgroundCommandExit,
	backgroundCommandNoticeMessage,
	hasOpenBackgroundCommand,
	withBackgroundCommandExits,
} from "#/domain/background-command";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { SessionItem } from "#/domain/session-item";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
} from "../adapters/agent-sessions";
import { hasActiveApiTurn } from "../adapters/api-turns";
import {
	idleSessionsWithOpenBackgroundCommands,
	replaceIdleSessionItems,
} from "../adapters/background-command-sessions";
import { stageServerPeerMessage } from "../adapters/server-peer-inbox";
import { agentOutputDirectory } from "./agent-output-artifacts";
import {
	deliverParentTaskNotification,
	REPORT_HELD_FOR_TURN,
} from "./agent-task-event-delivery";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import {
	COMMAND_TMUX_SOCKET,
	commandRoot,
	commandSessionName,
	STOPPED_COMMAND_STATUS,
} from "./api-agent-command-tools";
import {
	backgroundCommandMaxSeconds,
	backgroundCommandScope,
	COMMAND_STOP_SCRIPT,
	commandScopeRoot,
} from "./api-command-scope";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Completion notices for background commands (background-command.ts). The
 * machine is the record: the launch writes `<id>.background` (label, start)
 * beside the command's status in the session's command root, and
 * `<id>.notified` says who learnt of its exit: "agent" when the agent stopped
 * it or saw it finish (stop_command, ytimesy-job, a read of its status), or
 * "notice" once a notice was claimed for it. A notice is claimed with an
 * exclusive create, so the running turn and the idle-chat watcher never both
 * deliver one.
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
        results.append({'id': identifier, 'running': True})
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
		z.object({ id: z.uuid(), running: z.literal(true) }),
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

/** The ids of background commands the timeline records as not exited (the newest 20). */
export function openBackgroundCommandIds(items: readonly SessionItem[]) {
	const ids = items.flatMap((item) =>
		item.kind === "dynamicToolCall" &&
		item.background &&
		item.background.exitCode === undefined
			? [item.background.id]
			: [],
	);
	return [...new Set(ids)].slice(-20);
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
	const ids = z.array(z.uuid()).max(20).parse(input.ids);
	if (!ids.length) return [];
	const { machines, vm } = await resolveToolWorkspace(input);
	const result = await machines.exec(
		vm,
		`python3 -c ${quote(observeScript())} ${quote(commandRoot(input.sessionId))} ${quote(agentOutputDirectory(input.sessionId))} ${input.claim ? 1 : 0} ${quote(JSON.stringify(ids))}`,
		15_000,
	);
	if (result.exitCode)
		throw new Error("Could not observe background commands.");
	return observation
		.parse(JSON.parse(result.stdout))
		.flatMap((entry) => (entry.running ? [] : [entry]));
}

/** A stable notification id per command (the peer inbox dedupes on it). */
export function backgroundNoticeId(sessionId: string, commandId: string) {
	const hash = createHash("sha256")
		.update(`background-command:${sessionId}:${commandId}`)
		.digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Before a model step: records exits on the background command cards and, for
 * exits nobody announced yet, adds the notice to the history. `claim: false`
 * (the turn's end) only records exits that were already announced or seen.
 */
export async function withBackgroundCommandNotices(
	input: AgentToolWorkspaceInput & {
		sessionId: string;
		items: SessionItem[];
		messages: ModelMessage[];
		claim?: boolean;
	},
): Promise<{
	items: SessionItem[];
	messages: ModelMessage[];
	changed: boolean;
}> {
	const unchanged = {
		items: input.items,
		messages: input.messages,
		changed: false,
	};
	if (!hasOpenBackgroundCommand(input.items)) return unchanged;
	const exits = await observeBackgroundCommands({
		...input,
		ids: openBackgroundCommandIds(input.items),
		claim: input.claim ?? true,
	});
	if (!exits.length) return unchanged;
	const items = withBackgroundCommandExits(input.items, exits);
	const fresh = exits.filter((exit) => exit.fresh);
	return {
		items,
		messages: fresh.length
			? [
					...input.messages,
					{ role: "user", content: backgroundCommandNoticeMessage(fresh) },
				]
			: input.messages,
		changed: items !== input.items || fresh.length > 0,
	};
}

/** Dependencies of the idle-chat watcher (tests replace them). */
export type BackgroundWatchDependencies = {
	readonly candidates: (
		maxSeconds: number,
	) => Promise<readonly { userId: string; id: string }[]>;
	readonly session: (
		userId: string,
		sessionId: string,
	) => Promise<AgentSessionRecord | null>;
	readonly activeTurn: (userId: string, sessionId: string) => Promise<boolean>;
	readonly replaceItems: (
		userId: string,
		sessionId: string,
		expected: unknown,
		next: readonly SessionItem[],
	) => Promise<boolean>;
	readonly notify: (
		machines: WorkspaceMachines,
		session: AgentSessionRecord,
		notificationId: string,
		text: string,
	) => Promise<void>;
};

const watchDependencies = (): BackgroundWatchDependencies => ({
	candidates: idleSessionsWithOpenBackgroundCommands,
	session: agentSessionForOwner,
	activeTurn: hasActiveApiTurn,
	replaceItems: replaceIdleSessionItems,
	notify: async (machines, session, notificationId, text) => {
		try {
			await deliverParentTaskNotification(
				machines,
				session,
				notificationId,
				text,
			);
		} catch (error) {
			// A turn started meanwhile: its own command's exit is read at its next step.
			if (error instanceof Error && error.message === REPORT_HELD_FOR_TURN)
				await stageServerPeerMessage(session.id, notificationId, text);
			else throw error;
		}
	},
});

/**
 * The cron's watcher for chats between turns (maintenance "supervise"): a
 * background command that exited gets its card updated and its notice
 * delivered, which wakes the agent that started it the way a subagent's
 * report does (or reaches a turn that just started at its next step).
 */
export async function wakeChatsForBackgroundCommands(
	machines: WorkspaceMachines,
	dependencies: BackgroundWatchDependencies = watchDependencies(),
) {
	let woken = 0;
	for (const candidate of await dependencies.candidates(
		backgroundCommandMaxSeconds(),
	)) {
		try {
			const session = await dependencies.session(
				candidate.userId,
				candidate.id,
			);
			if (
				!session?.providerRef ||
				session.turnStatus === "running" ||
				(await dependencies.activeTurn(session.userId, session.id))
			)
				continue;
			const scoped = machinesForAgentSession(machines, session);
			const vm = WorkspaceId(session.providerRef);
			// A stopped machine stopped its commands; never start one to look.
			if (!(await scoped.isRunning(vm))) continue;
			// The stored items as they are (compare-and-set below).
			const stored = Array.isArray(session.items)
				? (session.items as SessionItem[])
				: [];
			const exits = await observeBackgroundCommands({
				machines: scoped,
				vm,
				cwd: "/",
				sessionId: session.id,
				ids: openBackgroundCommandIds(stored),
				claim: true,
			});
			if (!exits.length) continue;
			const next = withBackgroundCommandExits(stored, exits);
			if (next !== stored)
				await dependencies.replaceItems(
					session.userId,
					session.id,
					session.items,
					next,
				);
			const fresh = exits.filter((exit) => exit.fresh);
			if (!fresh.length) continue;
			try {
				await dependencies.notify(
					machines,
					session,
					backgroundNoticeId(session.id, fresh[0].id),
					backgroundCommandNoticeMessage(fresh),
				);
			} catch (error) {
				// A turn that started meanwhile reads the staged notice at its next step.
				if (!(await dependencies.activeTurn(session.userId, session.id)))
					throw error;
			}
			woken += 1;
		} catch (error) {
			console.warn("A background command notice was not delivered.", {
				sessionId: candidate.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return woken;
}

/** The user stops one of a chat's background commands (no notice: the agent did not ask for it to end). */
export async function stopBackgroundCommandForUser(
	machines: WorkspaceMachines,
	session: AgentSessionRecord,
	commandId: string,
) {
	z.uuid().parse(commandId);
	if (!session.providerRef) return { stopped: false };
	const scoped = machinesForAgentSession(machines, session);
	const vm = WorkspaceId(session.providerRef);
	if (!(await scoped.isRunning(vm))) return { stopped: false };
	const root = commandRoot(session.id);
	const base = `${root}/${commandId}`;
	const result = await scoped.exec(
		vm,
		`test -f ${quote(`${base}.background`)} || exit 2; test -f ${quote(`${base}.notified`)} || printf user >${quote(`${base}.notified`)}; python3 -c ${quote(COMMAND_STOP_SCRIPT)} ${quote(commandScopeRoot(backgroundCommandScope(session.id)))} ${quote(commandId)}; tmux -L ${COMMAND_TMUX_SOCKET} kill-session -t ${quote(commandSessionName(commandId))} 2>/dev/null; test -f ${quote(`${base}.status`)} || printf '${STOPPED_COMMAND_STATUS}\\n' >${quote(`${base}.status`)}`,
		20_000,
	);
	if (result.exitCode === 2)
		throw new Error("That background command is not in this chat.");
	if (result.exitCode)
		throw new Error("The background command could not be stopped.");
	return { stopped: true };
}
