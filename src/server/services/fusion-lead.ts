import type { ToolSet } from "ai";
import { leanToolNames } from "#/domain/harness-model-profile";
import type { SessionItem } from "#/domain/session-item";
import {
	currentSidekickRound,
	endSidekickRound,
	latestUserRequestId,
	requestExplored,
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
import { stageServerPeerMessage } from "../adapters/server-peer-inbox";
import { saveSidekickState } from "../adapters/subagents";
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
 * each of the lead's model calls:
 *
 * - A new user request without an exploration round gets one, started by
 *   the harness from the request itself, so the lead's first model call
 *   already carries the sidekick's files and snippets.
 * - One writer at a time in the shared checkout: while the sidekick is in a
 *   round the lead makes no model call (its turn waits, across durable
 *   steps), and its report is put in the lead's mailbox the moment it
 *   exists, so the next model call carries it.
 * - So the lead's turn cannot complete while a round runs: its final
 *   answer comes after the last round's report.
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
 * Whether one of the lead's sidekicks is in a round, or its last round's
 * report has not reached the lead's mailbox yet. A report that exists is
 * staged in the mailbox now (the same message delivery would stage).
 */
async function roundInProgress(
	deps: FusionLeadDeps,
	lead: AgentSessionRecord,
	sidekicks: readonly Sidekick[],
) {
	const now = deps.now();
	let waiting = false;
	for (const sidekick of sidekicks) {
		const round = currentSidekickRound(sidekick.state);
		if (!round) continue;
		const events = await deps.reportEvents(
			sidekick.session.id,
			round.startedAt,
		);
		for (const event of events.filter((entry) => entry.pending))
			await deps.stage(
				lead.id,
				event.id,
				boundedNotificationText(subagentReportNotification(event)),
			);
		if (events.length) continue;
		if (sidekickRoundOpen(sidekick.state)) {
			if (
				!sidekick.live &&
				now - Date.parse(round.startedAt) > STALLED_ROUND_MS
			) {
				// Its turn never started or died without a report: the lead goes on.
				await deps.saveState(
					sidekick.session.id,
					endSidekickRound(sidekick.state, {
						now: new Date(now).toISOString(),
						outcome: "failed",
						patchFiles: 0,
					}),
				);
				await deps.stage(
					lead.id,
					`sidekick-stalled:${sidekick.session.id}:${round.n}`,
					`Runtime notice: your sidekick's round ${round.n} did not run or report. Its changes, if any, are in your checkout (git status). Send the brief again with agent_send, or do it yourself.`,
				);
				continue;
			}
			waiting = true;
		} else if (round.endedAt && now - Date.parse(round.endedAt) < REPORT_LAG_MS)
			// The round is recorded as ended; its report event follows.
			waiting = true;
	}
	return waiting;
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
 * Before a lead's model call: starts the request's exploration when it has
 * none, then waits while the sidekick works. "ready": the model may be
 * called (any report is in the lead's mailbox); "wait": the round still
 * runs at `waitUntil`, so the step ends and the next one waits on.
 */
export async function fusionLeadGate(
	input: FusionLeadGateInput,
): Promise<"ready" | "wait"> {
	const deps = { ...defaultDeps, ...input.deps };
	const lead = input.context.parent;
	const signal = input.context.signal;
	const requestKey = latestUserRequestId(input.items);
	const text = requestKey ? requestText(input.items, requestKey) : "";
	let explorationTried = !input.explore || !requestKey || !text.trim();
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
					.catch((cause) => {
						// The lead plans without the snippets; it may start its sidekick itself.
						console.warn(
							"The harness could not start the sidekick's exploration.",
							{
								message:
									cause instanceof Error ? cause.message.slice(0, 200) : "",
							},
						);
						return null;
					});
				if (started) sidekicks = await leadSidekicks(deps, lead);
			}
		}
		if (!(await roundInProgress(deps, lead, sidekicks))) return "ready";
		const left = input.waitUntil - deps.now();
		if (left <= 0) return "wait";
		await deps.sleep(Math.min(POLL_MS, left), signal);
	}
}

/** Whether a lead's sidekick round is still open (its turn's completion check). */
export async function fusionRoundOpen(
	lead: AgentSessionRecord,
	deps: Partial<FusionLeadDeps> = {},
) {
	const all = { ...defaultDeps, ...deps };
	return (await leadSidekicks(all, lead)).some((sidekick) =>
		sidekickRoundOpen(sidekick.state),
	);
}

/** The tools that write the checkout or run commands in it. */
const WRITING_TOOLS = new Set<string>(
	leanToolNames(["write", "edit", "command"]),
);

export const LEAD_WAITS_NOTICE =
	"Your sidekick is working in your checkout this round, so you do not edit files or run commands now: the runtime holds your next step until its report arrives, then review its changes in place.";

/**
 * The lead's writing tools refuse while a round it just started runs (a
 * call in the same batch as the agent_send that started it); from the next
 * step on the gate keeps the lead waiting instead.
 */
export function withSidekickWriteGuard(
	tools: ToolSet,
	busy: () => boolean,
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
						if (busy()) throw new Error(LEAD_WAITS_NOTICE);
						return execute(...args);
					},
				},
			];
		}),
	) as ToolSet;
}
