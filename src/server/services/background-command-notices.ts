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
	agentSessionMetadataForOwner,
	backgroundCommandItemsForOwner,
} from "../adapters/agent-sessions";
import { hasActiveApiTurn } from "../adapters/api-turns";
import {
	idleSessionsWithOpenBackgroundCommands,
	replaceIdleSessionItems,
} from "../adapters/background-command-sessions";
import { stageServerPeerMessage } from "../adapters/server-peer-inbox";
import {
	deliverParentTaskNotification,
	ReportHeldForTurn,
} from "./agent-task-event-delivery";
import type { AgentToolWorkspaceInput } from "./agent-tool-workspace";
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
import { observeBackgroundCommands } from "./background-command-observation";
import { settleBackgroundIdleTimeout } from "./background-idle-timeout";
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
	readonly candidates: () => Promise<readonly { userId: string; id: string }[]>;
	readonly session: (
		userId: string,
		sessionId: string,
	) => Promise<AgentSessionRecord | null>;
	/**
	 * The chat without its transcript, with only its background command
	 * items. The check runs every minute per chat with an open command, so
	 * reading the whole transcript (up to megabytes) each time made it a third
	 * of the database's egress; `session` is read only when something exits.
	 */
	readonly open?: (
		userId: string,
		sessionId: string,
	) => Promise<{
		session: Omit<AgentSessionRecord, "items">;
		items: SessionItem[];
	} | null>;
	readonly activeTurn: (userId: string, sessionId: string) => Promise<boolean>;
	/** Best effort, never throws (background-idle-timeout.ts); tests replace it. */
	readonly settleIdleTimeout?: (
		machines: WorkspaceMachines,
		vm: WorkspaceId,
	) => Promise<unknown>;
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
	open: async (userId, sessionId) => {
		const session = await agentSessionMetadataForOwner(userId, sessionId);
		if (!session) return null;
		const items = await backgroundCommandItemsForOwner(userId, [sessionId]);
		return {
			session,
			items: (items.get(sessionId) ?? []) as SessionItem[],
		};
	},
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
			if (error instanceof ReportHeldForTurn)
				await stageServerPeerMessage(session.id, notificationId, text);
			else throw error;
		}
	},
});

/** Chats one watcher pass checks at once (each is a guest call of up to 15s). */
export const BACKGROUND_WAKE_CONCURRENCY = 6;
/** No new chat is started after this; the next tick picks up the rest. */
export const BACKGROUND_WAKE_BUDGET_MS = 40_000;

/**
 * The cron's watcher for chats between turns (maintenance "supervise"): a
 * background command that exited gets its card updated and its notice
 * delivered, which wakes the agent that started it the way a subagent's
 * report does (or reaches a turn that just started at its next step).
 * Chats are checked a few at a time, never one after another: each check is
 * a guest call, and a serial pass over many chats with long-running commands
 * held the tick (and the newest chat's exit) for minutes.
 */
export async function wakeChatsForBackgroundCommands(
	machines: WorkspaceMachines,
	dependencies: BackgroundWatchDependencies = watchDependencies(),
	options: { concurrency?: number; budgetMs?: number; now?: () => number } = {},
) {
	const concurrency = Math.max(
		1,
		options.concurrency ?? BACKGROUND_WAKE_CONCURRENCY,
	);
	const now = options.now ?? Date.now;
	const deadline = now() + (options.budgetMs ?? BACKGROUND_WAKE_BUDGET_MS);
	const candidates = [...(await dependencies.candidates())];
	let woken = 0;
	let next = 0;
	const worker = async () => {
		while (next < candidates.length && now() < deadline) {
			const candidate = candidates[next];
			next += 1;
			if (
				(await wakeChatForBackgroundCommands(
					machines,
					candidate,
					dependencies,
				)) === "woken"
			)
				woken += 1;
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
	);
	return woken;
}

/**
 * One chat's check, for the cron's watcher and for a command's exit callback
 * (`commandId`: background-exit-wake.ts). Both claim a notice on the machine
 * with an exclusive create and deliver it under a stable id, so a command's
 * exit is announced once whichever of them (or a running turn) sees it first.
 * A callback whose command the timeline already closed costs no guest call.
 * "busy": the chat's turn runs, so this check was left to it (a callback
 * retries later, in case the turn ended before it saw the exit).
 */
export async function wakeChatForBackgroundCommands(
	machines: WorkspaceMachines,
	candidate: { userId: string; id: string; commandId?: string },
	dependencies: BackgroundWatchDependencies = watchDependencies(),
): Promise<"woken" | "busy" | "idle"> {
	try {
		const opened = dependencies.open
			? await dependencies.open(candidate.userId, candidate.id)
			: null;
		const read = opened
			? null
			: await dependencies.session(candidate.userId, candidate.id);
		const session = opened?.session ?? read;
		if (!session?.providerRef) return "idle";
		// The background items (or the whole transcript on the full path).
		const stored: SessionItem[] =
			opened?.items ??
			(Array.isArray(read?.items) ? (read?.items as SessionItem[]) : []);
		const open = openBackgroundCommandIds(stored);
		if (
			!open.length ||
			(candidate.commandId && !open.includes(candidate.commandId))
		)
			return "idle";
		if (
			session.turnStatus === "running" ||
			(await dependencies.activeTurn(session.userId, session.id))
		)
			return "busy";
		const scoped = machinesForAgentSession(machines, session);
		const vm = WorkspaceId(session.providerRef);
		// A stopped machine stopped its commands (nothing ran on to exit
		// normally): their cards close as interrupted, without starting it.
		const running = await scoped.isRunning(vm);
		const observed = running
			? await observeBackgroundCommands({
					machines: scoped,
					vm,
					cwd: "/",
					sessionId: session.id,
					ids: open,
					claim: true,
				})
			: [];
		const exits = [
			...observed,
			...interruptedBackgroundCommands(
				stored,
				open.filter((id) => !observed.some((exit) => exit.id === id)),
				running,
				Date.now(),
			),
		];
		if (!exits.length) return "idle";
		// Something exits: only now is the whole transcript read (compare-and-set).
		const current =
			read ?? (await dependencies.session(candidate.userId, candidate.id));
		if (!current) return "idle";
		const whole = Array.isArray(current.items)
			? (current.items as SessionItem[])
			: [];
		const next = withBackgroundCommandExits(whole, exits);
		if (next !== whole)
			await dependencies.replaceItems(
				current.userId,
				current.id,
				current.items,
				next,
			);
		const fresh = exits.filter((exit) => exit.fresh);
		if (fresh.length)
			try {
				await dependencies.notify(
					machines,
					current,
					backgroundNoticeId(session.id, fresh[0].id),
					backgroundCommandNoticeMessage(fresh),
				);
			} catch (error) {
				// A turn that started meanwhile reads the staged notice at its next step.
				if (!(await dependencies.activeTurn(session.userId, session.id)))
					throw error;
			}
		// The chat's last background command ended: its running VM goes back to
		// the short idle timeout, unless another chat's command still runs on it
		// (checked on the machine). A stopped VM is left alone (no resume).
		if (running && !hasOpenBackgroundCommand(next))
			await (dependencies.settleIdleTimeout ?? settleBackgroundIdleTimeout)(
				machines,
				vm,
			);
		return fresh.length ? "woken" : "idle";
	} catch (error) {
		console.warn("A background command notice was not delivered.", {
			sessionId: candidate.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return "idle";
	}
}

/**
 * Open cards whose command cannot still be running: its machine is stopped,
 * or it is older than the safety cap (which ends commands). They close as
 * interrupted with no notice (nobody is left to act on one); without this a
 * card whose notice was lost stays "running" forever.
 */
function interruptedBackgroundCommands(
	items: readonly SessionItem[],
	ids: readonly string[],
	machineRunning: boolean,
	now: number,
): (BackgroundCommandExit & { announced: boolean; fresh: boolean })[] {
	const cap = backgroundCommandMaxSeconds() * 1000;
	const exits: (BackgroundCommandExit & {
		announced: boolean;
		fresh: boolean;
	})[] = [];
	for (const item of items) {
		const record =
			item.kind === "dynamicToolCall" ? item.background : undefined;
		if (!record || !ids.includes(record.id)) continue;
		if (machineRunning && now - record.startedAt <= cap) continue;
		exits.push({
			id: record.id,
			label: record.label,
			startedAt: record.startedAt,
			endedAt: now,
			exitCode: "interrupted",
			outputPath: "",
			lastLines: "",
			announced: false,
			fresh: false,
		});
	}
	return exits;
}

/** The user stops one of a chat's background commands (no notice: the agent did not ask for it to end). */
export async function stopBackgroundCommandForUser(
	machines: WorkspaceMachines,
	session: Omit<AgentSessionRecord, "items">,
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
