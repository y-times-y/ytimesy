import type { ToolSet } from "ai";
import { leanToolNames } from "#/domain/harness-model-profile";
import type { SessionItem } from "#/domain/session-item";
import {
	currentSidekickRound,
	endSidekickRound,
	latestUserRequestId,
	requestExplored,
	retireSidekickState,
	type SidekickState,
	sidekickRoundOpen,
	sidekickState,
} from "#/domain/sidekick";
import { subagentTree } from "#/domain/subagent-tree";
import {
	type AgentSessionRecord,
	descendantAgentSessions,
} from "../adapters/agent-sessions";
import { childReportEventsSince } from "../adapters/agent-task-events";
import { hasActiveApiTurn } from "../adapters/api-turns";
import {
	serverPeerMessageStaged,
	stageServerPeerMessage,
} from "../adapters/server-peer-inbox";
import { requestSubagentStop, saveSidekickState } from "../adapters/subagents";
import {
	boundedNotificationText,
	subagentReportNotification,
} from "./agent-task-event-delivery";
import {
	type SubagentToolContext,
	startHarnessExploration,
} from "./subagent-tools";

/**
 * Lead mode fusion's turn rules (src/domain/sidekick.ts), checked before
 * each of Main's model calls:
 *
 * - A new user request without an exploration round gets one, started by
 *   the harness from the request itself, and Main's first model call waits
 *   for it, so it already carries the writer's files and snippets.
 * - Build rounds release Main: it may read, plan and talk to the user while
 *   its writer works, but its own edits and commands are refused while a
 *   round is open (one writer at a time in the shared checkout). Main's turn
 *   may end while a round runs; the round's report reaches Main as any
 *   helper report does (agent-task-event-delivery.ts), after Main's turn.
 */

/** A round with no live sidekick and no report for this long is given up. */
const STALLED_ROUND_MS = 5 * 60_000;
/** A reported round's event may lag its state by this much. */
const REPORT_LAG_MS = 60_000;
const POLL_MS = 3_000;

export type FusionLeadDeps = {
	readonly now: () => number;
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly children: (
		userId: string,
		leadId: string,
	) => Promise<readonly AgentSessionRecord[]>;
	readonly reportEvents: typeof childReportEventsSince;
	readonly stage: typeof stageServerPeerMessage;
	readonly saveState: typeof saveSidekickState;
	readonly explore: typeof startHarnessExploration;
	/** Whether the session has a queued or running turn (a round about to run). */
	readonly activeTurn: typeof hasActiveApiTurn;
	readonly stop: typeof requestSubagentStop;
	/** Whether the lead's mailbox already holds this notice (accepted or not). */
	readonly staged: typeof serverPeerMessageStaged;
};

const defaultDeps: FusionLeadDeps = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
		}),
	children: async (userId, leadId) =>
		(await descendantAgentSessions(userId, leadId)).filter(
			(child) => child.parentSessionId === leadId,
		),
	reportEvents: (...args) => childReportEventsSince(...args),
	stage: (...args) => stageServerPeerMessage(...args),
	saveState: (...args) => saveSidekickState(...args),
	explore: (...args) => startHarnessExploration(...args),
	activeTurn: (...args) => hasActiveApiTurn(...args),
	stop: (...args) => requestSubagentStop(...args),
	staged: (...args) => serverPeerMessageStaged(...args),
};

type Sidekick = {
	readonly session: AgentSessionRecord;
	readonly state: SidekickState;
	readonly live: boolean;
};

async function leadSidekicks(
	deps: FusionLeadDeps,
	lead: AgentSessionRecord,
): Promise<Sidekick[]> {
	const children = await deps.children(lead.userId, lead.id);
	const now = deps.now();
	const nodes = subagentTree(lead.id, [lead, ...children], now).nodes;
	return children.flatMap((session) => {
		const state = sidekickState(session);
		return state
			? [
					{
						session,
						state,
						live: !!nodes.find((node) => node.id === session.id)?.live,
					},
				]
			: [];
	});
}

/** The request's own text (its message), for the exploration brief. */
function requestText(items: readonly SessionItem[], requestKey: string) {
	const item = items.find((entry) => String(entry.id) === requestKey);
	return item?.kind === "userMessage" ? item.text : "";
}

/**
 * The one rule for whether a sidekick round is still in progress, read by
 * the gate and by the completion check alike. A round is over once its
 * report event exists, whatever its state says (a worker-disconnect
 * recovery or a failed save can leave the state open): such a round is
 * closed in the state now. Without an event it is in progress while its
 * state is open, or for a short lag after its state closed (the event
 * follows). An open round whose sidekick has no live or queued turn for
 * STALLED_ROUND_MS is abandoned: closed, the sidekick retired and stopped
 * at once, the lead told. With `stage`, reports that exist are put in the
 * lead's mailbox. Returns the rounds still in progress.
 */
async function roundsInProgress(
	deps: FusionLeadDeps,
	lead: AgentSessionRecord,
	sidekicks: readonly Sidekick[],
	options: { readonly stage: boolean },
) {
	const now = deps.now();
	const iso = new Date(now).toISOString();
	const pending: {
		readonly startedAt: string;
		readonly kind?: "explore" | "build";
	}[] = [];
	for (const sidekick of sidekicks) {
		const round = currentSidekickRound(sidekick.state);
		if (!round) continue;
		const events = await deps.reportEvents(
			sidekick.session.id,
			round.startedAt,
		);
		if (events.length) {
			// Only an exploration's report is Main's input mid-turn; a build
			// round's report is delivered after Main's turn ends.
			if (options.stage && round.kind === "explore")
				for (const event of events.filter((entry) => entry.pending))
					await deps.stage(
						lead.id,
						event.id,
						boundedNotificationText(subagentReportNotification(event)),
					);
			if (sidekickRoundOpen(sidekick.state))
				await deps.saveState(
					sidekick.session.id,
					endSidekickRound(sidekick.state, {
						now: iso,
						outcome:
							events.at(-1)?.eventType === "failed" ? "failed" : "finished",
						patchFiles: round.patchFiles ?? 0,
					}),
				);
			continue;
		}
		if (sidekickRoundOpen(sidekick.state)) {
			const stalled =
				now - Date.parse(round.startedAt) > STALLED_ROUND_MS &&
				!sidekick.live &&
				!(await deps.activeTurn(lead.userId, sidekick.session.id));
			if (!stalled) {
				pending.push(round);
				continue;
			}
			// Its turn never started or died without a report. It must not start
			// later and write beside the lead: retired (its queued round message
			// is then dropped on delivery) and stopped at once.
			await deps.saveState(
				sidekick.session.id,
				retireSidekickState(
					endSidekickRound(sidekick.state, {
						now: iso,
						outcome: "failed",
						patchFiles: 0,
					}),
					`round ${round.n} did not run or report`,
					iso,
				),
			);
			await deps.stop(sidekick.session.id, { now: true });
			await deps.stage(
				lead.id,
				`sidekick-stalled:${sidekick.session.id}:${round.n}`,
				`Runtime notice: your writer's round ${round.n} did not run or report, so it is retired. Its changes, if any, are in your checkout (git status). Start a new writer for the brief, or do it yourself.`,
			);
			continue;
		}
		if (round.endedAt && now - Date.parse(round.endedAt) < REPORT_LAG_MS)
			// The round is recorded as ended; its report event follows.
			pending.push(round);
	}
	return pending;
}

export type FusionLeadGateInput = {
	/** The lead's tool context (its sidekick is started with it). */
	readonly context: SubagentToolContext;
	/** The lead's chat items (the current user request is the latest). */
	readonly items: readonly SessionItem[];
	/** The pair profile lets the sidekick explore (fusion-pairs.ts). */
	readonly explore: boolean;
	/** The latest time this step may wait. */
	readonly waitUntil: number;
	readonly deps?: Partial<FusionLeadDeps>;
};

/**
 * Before Main's model call: starts the request's exploration when it has
 * none and waits for it. "ready": no round is open (Main may write);
 * "busy": a build round is open, Main is called but its writes refuse;
 * "wait": an exploration still runs at `waitUntil`, so the step ends and
 * the next one waits on.
 */
export async function fusionLeadGate(
	input: FusionLeadGateInput,
): Promise<"ready" | "busy" | "wait"> {
	const deps = { ...defaultDeps, ...input.deps };
	const lead = input.context.parent;
	const signal = input.context.signal;
	const requestKey = latestUserRequestId(input.items);
	const text = requestKey ? requestText(input.items, requestKey) : "";
	let explorationTried = !input.explore || !requestKey || !text.trim();
	// One attempt per request: a failed start leaves a notice in the lead's
	// mailbox, and the lead plans without snippets from then on.
	const failedNotice = `exploration-failed:${lead.id}:${requestKey}`;
	if (!explorationTried && (await deps.staged(lead.id, failedNotice)))
		explorationTried = true;
	for (;;) {
		signal.throwIfAborted();
		let sidekicks = await leadSidekicks(deps, lead);
		if (
			!explorationTried &&
			requestKey &&
			!sidekicks.some((sidekick) => sidekick.live)
		) {
			explorationTried = true;
			if (
				!requestExplored(
					sidekicks.map((sidekick) => sidekick.state),
					requestKey,
				)
			) {
				const started = await deps
					.explore(input.context, { requestKey, requestText: text })
					.catch(async (cause) => {
						// The lead plans without the snippets; it may start its sidekick itself.
						const message =
							cause instanceof Error ? cause.message.slice(0, 300) : "";
						console.warn(
							"The harness could not start the sidekick's exploration.",
							{ message },
						);
						await deps.stage(
							lead.id,
							failedNotice,
							`Runtime notice: the sidekick's exploration of this request could not start (${message || "unknown error"}). Plan from your own reading, or start a writer with explore: true.`,
						);
						return null;
					});
				if (started) sidekicks = await leadSidekicks(deps, lead);
			}
		}
		const open = await roundsInProgress(deps, lead, sidekicks, {
			stage: true,
		});
		if (!open.length) return "ready";
		if (!open.some((round) => round.kind === "explore")) return "busy";
		const left = input.waitUntil - deps.now();
		if (left <= 0) return "wait";
		await deps.sleep(Math.min(POLL_MS, left), signal);
	}
}

/** The tools that write the checkout or run commands in it. */
const WRITING_TOOLS = new Set<string>(
	leanToolNames(["write", "edit", "command", "stdin"]),
);

export const LEAD_WAITS_NOTICE =
	"Your writer is working in your checkout this round, so you do not edit files or run commands until its report arrives. Meanwhile read, plan or answer the user; when nothing else is left, give the user a full status (what is running, why, what comes next) and end your turn: the report wakes you, then review its changes in place.";

/**
 * The lead's writes within one step: whether a sidekick round started
 * (its writing tools refuse from then on), and the writing calls still
 * running, which a round's start waits out before it snapshots the checkout
 * (a write earlier in the same batch than the handoff).
 */
export function leadWriteTracker() {
	let busy = false;
	const running = new Set<PromiseLike<unknown>>();
	return {
		busy: () => busy,
		/** A round starts: refuse the lead's writes for the rest of the step. */
		start: () => {
			busy = true;
		},
		/** The gate found no round running: the lead may write again. */
		clear: () => {
			busy = false;
		},
		track: <T>(result: T) => {
			if (result && typeof (result as { then?: unknown }).then === "function") {
				const pending = result as unknown as Promise<unknown>;
				running.add(pending);
				pending.then(
					() => running.delete(pending),
					() => running.delete(pending),
				);
			}
			return result;
		},
		/** Resolves once every writing call already started has finished. */
		settled: async () => {
			await Promise.allSettled([...running]);
		},
	};
}
export type LeadWriteTracker = ReturnType<typeof leadWriteTracker>;

/**
 * Main's writing tools (edits, commands, stdin to a running command)
 * refuse while a round is open: one it just started (a call in the same
 * batch as the handoff) or one the gate found running ("busy").
 */
export function withSidekickWriteGuard(
	tools: ToolSet,
	writes: Pick<LeadWriteTracker, "busy" | "track">,
): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, tool]) => {
			const execute = tool.execute;
			if (!WRITING_TOOLS.has(name) || !execute) return [name, tool];
			return [
				name,
				{
					...tool,
					execute: (...args: Parameters<typeof execute>) => {
						if (writes.busy()) throw new Error(LEAD_WAITS_NOTICE);
						return writes.track(execute(...args));
					},
				},
			];
		}),
	) as ToolSet;
}
