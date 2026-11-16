import { z } from "zod";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { WORKSPACE_PTY_SHELL_ARGS } from "#/domain/workspace-terminal";
import { backgroundCommandsRunningOn } from "./background-idle-timeout";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Pausing a turn's VM while its model thinks (YTIMESY_PAUSE_VM_WHILE_THINKING,
 * off by default). The provider's idle timeout pauses a VM only after a
 * minute without traffic, so through a turn the VM runs (and bills) almost
 * all the time although most of the turn is the model working between tool
 * calls. Here a turn pauses its VM a short grace after its last tool call
 * returned, when nothing else needs the VM awake, and every guest operation
 * through `resumingAfterThinkingPause` resumes it first (about 0.25-1.2 s,
 * docs/workspace-retention.md).
 *
 * Never pausing under work is the rule: a tool call of this turn in flight,
 * a machine call in flight in this isolate, another running turn on the VM
 * (a helper sharing it, from any isolate), a background command, an attached
 * desktop viewer or an open terminal each keep it running, and so does any
 * of those that could not be checked.
 */

export function pauseVmWhileThinkingEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	return env.YTIMESY_PAUSE_VM_WHILE_THINKING === "true";
}

/**
 * How long after the last tool call returned the VM stays up. Most models
 * answer a short tool result within seconds; pausing for those would only add
 * a resume to the next call.
 */
export const THINKING_PAUSE_GRACE_MS = 10_000;

/** The desktop viewer's proxy (websockify in start-desktop.ts). */
const DESKTOP_PROXY_PORT = 6080;

/** What decides a pause; undefined: not known (not checked, or the check failed). */
export type ThinkingPauseFacts = {
	/** This turn's tool calls still executing. */
	readonly toolsRunning: number;
	/** Guest operations on this VM still in flight in this isolate (any turn's). */
	readonly machineCallsRunning: number;
	/** The machines adapter can pause a VM. */
	readonly canPause: boolean;
	readonly otherTurnOnMachine?: boolean;
	readonly backgroundCommands?: number;
	readonly desktopViewers?: number;
	readonly terminals?: number;
};

export type ThinkingPauseBlocker =
	| "tool-running"
	| "machine-call-running"
	| "unsupported"
	| "other-turn"
	| "background-command"
	| "desktop-attached"
	| "terminal-open"
	| "unknown";

/**
 * Whether the VM may pause now. Checked in the order the facts are cheapest
 * to learn, so a caller can stop gathering at the first known blocker; an
 * unknown fact blocks.
 */
export function thinkingPauseDecision(
	facts: ThinkingPauseFacts,
): { pause: true } | { pause: false; reason: ThinkingPauseBlocker } {
	const blocked = (reason: ThinkingPauseBlocker) =>
		({ pause: false, reason }) as const;
	if (facts.toolsRunning > 0) return blocked("tool-running");
	if (facts.machineCallsRunning > 0) return blocked("machine-call-running");
	if (!facts.canPause) return blocked("unsupported");
	if (facts.otherTurnOnMachine === undefined) return blocked("unknown");
	if (facts.otherTurnOnMachine) return blocked("other-turn");
	if (facts.backgroundCommands === undefined) return blocked("unknown");
	if (facts.backgroundCommands > 0) return blocked("background-command");
	if (facts.desktopViewers === undefined || facts.terminals === undefined)
		return blocked("unknown");
	if (facts.desktopViewers > 0) return blocked("desktop-attached");
	if (facts.terminals > 0) return blocked("terminal-open");
	return { pause: true };
}

/**
 * Counts attached desktop viewers (established connections to the viewer
 * proxy) and open terminals (the terminal's own shell, workspacePtyCommand),
 * then flushes the guest's page cache: a paused VM's files are read from its
 * disk image (readTextFile), which must already hold the last writes.
 */
const ATTACHMENTS_SCRIPT = `import json, os, sys
port = int(sys.argv[1])
shell_args = sys.argv[2:]
viewers = 0
for table in ('/proc/net/tcp', '/proc/net/tcp6'):
    try:
        rows = open(table).read().splitlines()[1:]
    except OSError:
        continue
    for row in rows:
        fields = row.split()
        if len(fields) > 3 and fields[3] == '01' and int(fields[1].rsplit(':', 1)[1], 16) == port:
            viewers += 1
terminals = 0
for pid in os.listdir('/proc'):
    if not pid.isdigit():
        continue
    try:
        args = open('/proc/' + pid + '/cmdline', 'rb').read().decode('utf-8', 'replace').split('\\0')
    except OSError:
        continue
    if args and os.path.basename(args[0]) == 'bash' and args[1:1 + len(shell_args)] == shell_args:
        terminals += 1
os.sync()
print(json.dumps({'viewers': viewers, 'terminals': terminals}))`;

const attachmentsOutput = z.object({
	viewers: z.number().int().nonnegative(),
	terminals: z.number().int().nonnegative(),
});

export async function guestAttachments(
	machines: Pick<WorkspaceMachines, "exec">,
	vm: WorkspaceId,
) {
	const result = await machines.exec(
		vm,
		`python3 -c ${quote(ATTACHMENTS_SCRIPT)} ${DESKTOP_PROXY_PORT} ${WORKSPACE_PTY_SHELL_ARGS.map(quote).join(" ")}`,
		15_000,
	);
	if (result.exitCode)
		throw new Error("Could not list the machine's attached sessions.");
	return attachmentsOutput.parse(JSON.parse(result.stdout));
}

/**
 * VMs paused (or being paused) through this isolate, and the guest
 * operations in flight on each. Module-wide: every turn in the isolate that
 * shares a VM sees one record.
 */
type MachineRecord = {
	inFlight: number;
	/** Settles once a pause attempt ends; true if the VM was paused. */
	pausing?: Promise<boolean>;
	pausedAt?: number;
	/** One resume shared by every operation that finds the VM paused. */
	resuming?: Promise<void>;
};
const records = new Map<string, MachineRecord>();

function recordFor(vm: string) {
	let record = records.get(vm);
	if (!record) {
		record = { inFlight: 0 };
		records.set(vm, record);
	}
	return record;
}

function forgetIdle(vm: string, record: MachineRecord) {
	if (
		!record.inFlight &&
		!record.pausing &&
		!record.pausedAt &&
		!record.resuming
	)
		records.delete(vm);
}

/** Guest operations on this VM in flight through `resumingAfterThinkingPause`. */
export function machineCallsInFlight(vm: string) {
	return records.get(vm)?.inFlight ?? 0;
}

/** When this isolate paused the VM for thinking and has not resumed it, else null. */
export function pausedForThinkingAt(vm: string) {
	return records.get(vm)?.pausedAt ?? null;
}

/**
 * A pause for thinking made by an earlier instance of this isolate's owner
 * (a chat object that hibernated while its Claude Code turn was parked): its
 * next guest operation resumes the VM as if this isolate had paused it.
 */
export function adoptThinkingPause(vm: WorkspaceId, pausedAt: number) {
	const record = recordFor(vm);
	if (record.pausing || record.resuming || record.pausedAt !== undefined)
		return;
	record.pausedAt = pausedAt;
}

type Log = (line: string) => void;

/**
 * Resumes a VM this isolate paused for thinking (waiting for a pause still
 * being made), before a guest operation. Concurrent callers share the resume.
 * A VM it did not pause is left alone: the operation's own path handles it.
 */
export async function resumeIfPausedForThinking(
	machines: Pick<WorkspaceMachines, "ensureRunning">,
	vm: WorkspaceId,
	options: { now?: () => number; log?: Log } = {},
) {
	const record = records.get(vm);
	if (!record) return;
	if (record.pausing) await record.pausing;
	if (record.pausedAt === undefined) return;
	const now = options.now ?? Date.now;
	const log = options.log ?? console.info;
	const pausedAt = record.pausedAt;
	record.resuming ??= (async () => {
		const startedAt = now();
		try {
			await machines.ensureRunning(vm);
			record.pausedAt = undefined;
			log(
				JSON.stringify({
					event: "vm.resumed_for_tool",
					vm,
					resumeMs: Math.max(0, Math.round(now() - startedAt)),
					pausedMs: Math.max(0, Math.round(startedAt - pausedAt)),
				}),
			);
		} finally {
			record.resuming = undefined;
		}
	})();
	await record.resuming;
}

/** Guest operations: each needs the VM running (a file read would see only its disk image). */
const GUEST_OPERATIONS = [
	"exec",
	"writeTextFile",
	"readTextFile",
	"readFile",
	"runCapability",
	"forkWorkspace",
	"snapshotEnvironment",
] as const;

/**
 * `machines` whose guest operations first resume a VM this isolate paused
 * for thinking, and count as in flight on it meanwhile (no pause starts under
 * them). Everything else passes through.
 */
export function resumingAfterThinkingPause<M extends WorkspaceMachines>(
	machines: M,
	options: { now?: () => number; log?: Log } = {},
): M {
	const wrapped: Record<string, unknown> = Object.fromEntries(
		Object.entries(machines),
	);
	for (const name of GUEST_OPERATIONS) {
		const operation = machines[name] as
			| ((vm: WorkspaceId, ...rest: unknown[]) => Promise<unknown>)
			| undefined;
		if (typeof operation !== "function") continue;
		wrapped[name] = async (vm: WorkspaceId, ...rest: unknown[]) => {
			const record = recordFor(vm);
			record.inFlight += 1;
			try {
				await resumeIfPausedForThinking(machines, vm, options);
				return await operation.call(machines, vm, ...rest);
			} finally {
				record.inFlight -= 1;
				forgetIdle(vm, record);
			}
		};
	}
	return wrapped as M;
}

/**
 * One pause check of a quiet VM: gathers the facts (stopping at the first
 * known blocker, or once `current` turns false) and pauses the VM if they
 * allow. `trigger` names a path other than the in-step grace in the logs
 * ("claude_parked": a parked Claude Code turn's chat object). Never throws.
 */
export async function attemptThinkingPause(input: {
	readonly vm: WorkspaceId;
	/** Plain machines (not a reader's): the probes run as the default user. */
	readonly machines: WorkspaceMachines;
	readonly otherTurnOnMachine: (vm: WorkspaceId) => Promise<boolean>;
	readonly backgroundCommands?: (vm: WorkspaceId) => Promise<number>;
	readonly attachments?: (
		vm: WorkspaceId,
	) => Promise<{ viewers: number; terminals: number }>;
	/** The turn's tool calls running (or queued) now. */
	readonly toolsRunning: () => number;
	/** False once something overtook the check (a tool call, a step). */
	readonly current: () => boolean;
	/** Since when nothing of the turn used the VM. */
	readonly quietSince: number;
	readonly trigger?: "claude_parked";
	readonly now?: () => number;
	readonly log?: Log;
}): Promise<"paused" | "skipped" | "overtaken"> {
	const { vm, machines } = input;
	const now = input.now ?? Date.now;
	const log = input.log ?? console.info;
	const backgroundCommands =
		input.backgroundCommands ??
		(async (target: WorkspaceId) =>
			(await backgroundCommandsRunningOn(machines, target)).length);
	const attachments =
		input.attachments ??
		((target: WorkspaceId) => guestAttachments(machines, target));
	const trigger = input.trigger ? { trigger: input.trigger } : {};
	let facts: ThinkingPauseFacts = {
		toolsRunning: input.toolsRunning(),
		machineCallsRunning: machineCallsInFlight(vm),
		canPause: typeof machines.pause === "function",
	};
	const settledBlocker = () => {
		const decision = thinkingPauseDecision(facts);
		return !decision.pause && decision.reason !== "unknown"
			? decision.reason
			: undefined;
	};
	const gather = async <K extends keyof ThinkingPauseFacts>(
		read: () => Promise<Pick<ThinkingPauseFacts, K>>,
	) => {
		if (settledBlocker() || !input.current()) return;
		facts = { ...facts, ...(await read().catch(() => ({}))) };
	};
	try {
		await gather(async () => ({
			otherTurnOnMachine: await input.otherTurnOnMachine(vm),
		}));
		await gather(async () => ({
			backgroundCommands: await backgroundCommands(vm),
		}));
		await gather(async () => {
			const found = await attachments(vm);
			return { desktopViewers: found.viewers, terminals: found.terminals };
		});
		if (!input.current()) return "overtaken";
		// In-isolate facts again, as of now: the probes took time.
		facts = {
			...facts,
			toolsRunning: input.toolsRunning(),
			machineCallsRunning: machineCallsInFlight(vm),
		};
		const decision = thinkingPauseDecision(facts);
		if (!decision.pause) {
			// Only the reasons worth counting in rollout: the cheap in-isolate
			// ones change between every call and say nothing.
			if (
				decision.reason !== "tool-running" &&
				decision.reason !== "machine-call-running"
			)
				log(
					JSON.stringify({
						event: "vm.pause_thinking_skipped",
						vm,
						reason: decision.reason,
						...trigger,
					}),
				);
			return "skipped";
		}
		const record = recordFor(vm);
		if (record.pausing || record.pausedAt !== undefined) return "skipped";
		const idleMs = Math.max(0, Math.round(now() - input.quietSince));
		// From here a guest operation on the VM waits for this pause and then
		// resumes it (resumeIfPausedForThinking).
		record.pausing = (async () => {
			try {
				await machines.pause?.(vm);
				record.pausedAt = now();
				log(
					JSON.stringify({
						event: "vm.paused_thinking",
						vm,
						idleMs,
						...(input.trigger ? { reason: input.trigger } : {}),
					}),
				);
				return true;
			} catch (error) {
				console.warn("The VM was not paused while the model thinks.", {
					vm,
					message:
						error instanceof Error ? error.message.slice(0, 200) : "unknown",
				});
				return false;
			} finally {
				record.pausing = undefined;
				forgetIdle(vm, record);
			}
		})();
		return (await record.pausing) ? "paused" : "skipped";
	} catch {
		return "skipped";
	}
}

export type ThinkingPauseTimers = {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
};

const realTimers: ThinkingPauseTimers = {
	set: (run, ms) => setTimeout(run, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One turn's pause scheduling. Tool calls report start and end; once none
 * runs, a grace timer starts, and any new tool call cancels it (and any
 * check still running when it fires). When it fires, the facts are gathered
 * and, if they allow, the VM is paused. Never throws into the turn.
 */
export function thinkingPauseScheduler(input: {
	/** The turn's VM, once its workspace is ready; nothing pauses before. */
	readonly vm: () => WorkspaceId | undefined;
	/** Plain machines (not a reader's): the probes run as the default user. */
	readonly machines: WorkspaceMachines;
	/** Whether another running turn uses the VM (otherRunningTurnOnMachine). */
	readonly otherTurnOnMachine: (vm: WorkspaceId) => Promise<boolean>;
	readonly graceMs?: number;
	readonly timers?: ThinkingPauseTimers;
	readonly now?: () => number;
	readonly log?: Log;
	/** Probes, replaceable in tests. */
	readonly backgroundCommands?: (vm: WorkspaceId) => Promise<number>;
	readonly attachments?: (
		vm: WorkspaceId,
	) => Promise<{ viewers: number; terminals: number }>;
}) {
	const graceMs = input.graceMs ?? THINKING_PAUSE_GRACE_MS;
	const timers = input.timers ?? realTimers;
	const now = input.now ?? Date.now;
	const running = new Set<string>();
	let timer: unknown;
	/** Bumped by every tool call start: a check from before it is void. */
	let generation = 0;
	let lastToolEndedAt = now();
	/** Whether a tool call of this step returned (else quiet since its start). */
	let toolEnded = false;
	let disposed = false;

	const cancel = () => {
		generation += 1;
		if (timer !== undefined) timers.clear(timer);
		timer = undefined;
	};

	const attempt = (vm: WorkspaceId, started: number) =>
		attemptThinkingPause({
			vm,
			machines: input.machines,
			otherTurnOnMachine: input.otherTurnOnMachine,
			...(input.backgroundCommands
				? { backgroundCommands: input.backgroundCommands }
				: {}),
			...(input.attachments ? { attachments: input.attachments } : {}),
			toolsRunning: () => running.size,
			current: () => started === generation && !disposed,
			quietSince: lastToolEndedAt,
			now,
			...(input.log ? { log: input.log } : {}),
		});

	const arm = () => {
		if (disposed || running.size > 0) return;
		cancel();
		const started = generation;
		timer = timers.set(() => {
			timer = undefined;
			const vm = input.vm();
			if (!vm || started !== generation || disposed) return;
			void attempt(vm, started).catch(() => undefined);
		}, graceMs);
	};

	return {
		/** A tool call started: no pause from now until the last one ends. */
		toolStarted(id: string) {
			if (disposed) return;
			running.add(id);
			cancel();
		},
		/** A tool call returned; the last one starts the grace. */
		toolEnded(id: string) {
			if (disposed) return;
			running.delete(id);
			lastToolEndedAt = now();
			toolEnded = true;
			if (running.size === 0) arm();
		},
		/**
		 * Since when nothing of the turn used the VM through this step: its
		 * last tool call's return, else the step's start (`toolEnded` false:
		 * an earlier quiet may still run on). Null with a tool call running.
		 */
		quiet() {
			return running.size > 0 ? null : { since: lastToolEndedAt, toolEnded };
		},
		/** The step ended: no pause is scheduled by it any more. */
		dispose() {
			disposed = true;
			cancel();
		},
	};
}

export type ThinkingPauseScheduler = ReturnType<typeof thinkingPauseScheduler>;
