import type { ModelMessage, ToolSet } from "ai";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import type { ApiTokenUsage } from "../../src/domain/api-token-usage";
import type { HarborModel } from "./config";

/**
 * The trial's child sessions, in memory (a Harbor trial is one process and
 * is never resumed): what the product keeps in its agent_sessions rows and
 * mailboxes for lead=fusion's sidekick, the review checker, a pair judge's
 * workers and the sidekick classifier's calls. Each session records its
 * role, parent, model, events (for usage and the ATIF subagent trajectory)
 * and its reports, one per round.
 */

export type TrialRole =
	| "sidekick"
	| "checker"
	| "checkerWorker"
	| "classifier"
	/** helpers=on: a read-only researcher or reviewer the root builder started. */
	| "helper";

export type TimedEvent = { at: string; event: ApiAgentEvent };

export type ChildReport = {
	readonly outcome: "completed" | "failed";
	readonly report: string;
	/** Set when the round stopped at its token budget: why (a failed round otherwise failed). */
	readonly budgetUsed?: string;
};

export type ChildSession = {
	readonly id: string;
	readonly role: TrialRole;
	/** The session that started it: the builder (trial id), or a checker judge. */
	readonly parentId: string;
	model: HarborModel;
	readonly events: TimedEvent[];
	/** Each round's brief (a sidekick or a worker briefed again keeps its context). */
	readonly briefs: string[];
	readonly reports: ChildReport[];
	instructions: string;
	tools: ToolSet;
	readonly startedAt: string;
	/** Event indexes where each of its model runs began (one per round). */
	readonly starts: number[];
	/** Its conversation so far: a sidekick or a worker briefed again keeps its context. */
	messages: ModelMessage[];
	/** Usage reported by a run outside the event stream (a classifier call). */
	extraUsage: ApiTokenUsage | null;
	/** Stops the session's current run; a no-op once none runs. */
	stop: () => void;
};

export function trialSessions(now: () => number = Date.now) {
	const sessions = new Map<string, ChildSession>();
	const counters = new Map<string, number>();
	return {
		/** A new child; its id is `<parent>.<n>` (the product's agent id shape) or `<prefix>-<n>`. */
		add(input: {
			role: TrialRole;
			parentId: string;
			model: HarborModel;
			brief?: string;
			id?: string;
		}): ChildSession {
			const key = input.parentId;
			const n = (counters.get(key) ?? 0) + 1;
			counters.set(key, n);
			const id = input.id ?? `${input.parentId}.${n}`;
			if (sessions.has(id)) throw new Error(`Session ${id} already exists.`);
			const session: ChildSession = {
				id,
				role: input.role,
				parentId: input.parentId,
				model: input.model,
				events: [],
				briefs: input.brief === undefined ? [] : [input.brief],
				reports: [],
				instructions: "",
				tools: {},
				startedAt: new Date(now()).toISOString(),
				starts: [],
				messages: [],
				extraUsage: null,
				stop: () => {},
			};
			sessions.set(id, session);
			return session;
		},
		get: (id: string) => sessions.get(id) ?? null,
		children: (parentId: string) =>
			[...sessions.values()].filter((session) => session.parentId === parentId),
		byRole: (role: TrialRole) =>
			[...sessions.values()].filter((session) => session.role === role),
		all: () => [...sessions.values()],
		/** The latest report of a session, or null while it has none. */
		latestReport: (id: string) => sessions.get(id)?.reports.at(-1) ?? null,
	};
}
export type TrialSessions = ReturnType<typeof trialSessions>;
