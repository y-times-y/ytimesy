import { backgroundCommandNoticeMessage } from "../../src/domain/background-command";
import type { AgentToolWorkspace } from "../../src/server/services/agent-tool-workspace";
import { backgroundCommandMaxSeconds } from "../../src/server/services/api-command-scope";
import {
	observeBackgroundCommandStates,
	unnotifiedBackgroundCommandIds,
} from "../../src/server/services/background-command-observation";

/**
 * The bridge's background-command completion gate: in the product a
 * background command's exit wakes the idle chat with a notice
 * (background-command-notices.ts), so the builder may end its turn while a
 * benchmark runs. A Harbor trial has no idle chat to wake; after a root
 * builder run ends, this waits (polling the machine's own command records)
 * for the first of the commands it left running to exit (as the product
 * wakes on each exit), then hands back the same notice for a continuation
 * run. Waiting stops at the trial deadline minus a margin for
 * the agent to act on the results, and at each command's own time limit.
 */

/** Gate rounds (continuations) per trial at most. */
export const BACKGROUND_GATE_MAX_ROUNDS = 5;
export const BACKGROUND_GATE_POLL_MS = 10_000;
/** One wait at most: a server left running on purpose never exits, so it must not hold the trial. */
export const BACKGROUND_GATE_MAX_WAIT_MS = 30 * 60_000;

/** One gate wait as the trace records it. */
export type BackgroundGateEntry = {
	readonly round: number;
	readonly at: string;
	readonly ids: readonly string[];
	readonly waitedSeconds: number;
	/** notified: a continuation follows; deadline: stopped waiting, trial left as is; seen: nothing new to announce; error: the machine could not be read. */
	readonly outcome: "notified" | "deadline" | "seen" | "aborted" | "error";
	readonly exitCodes: Readonly<Record<string, number | "interrupted">>;
	readonly stillRunning: readonly string[];
	readonly error?: string;
};

/** The margin left for the agent: 5 minutes or 10% of the remaining time, whichever is smaller. */
export function backgroundGateMarginMs(remainingMs: number) {
	return Math.min(5 * 60_000, Math.max(0, remainingMs) * 0.1);
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

/**
 * One gate check after a root builder run. Returns the notice message for a
 * continuation run (exits nobody announced yet, claimed so they are never
 * announced again), or null when there is nothing to continue with. Every
 * wait (even one that ends without a continuation) is returned as `entry`.
 */
export async function backgroundGate(input: {
	workspace: AgentToolWorkspace;
	sessionId: string;
	round: number;
	deadlineAt: number;
	signal: AbortSignal;
	now: () => number;
	pollMs?: number;
}): Promise<{ notice: string | null; entry: BackgroundGateEntry | null }> {
	const { now, signal } = input;
	const started = now();
	const pollMs = input.pollMs ?? BACKGROUND_GATE_POLL_MS;
	const observeInput = (ids: readonly string[], claim: boolean) => ({
		...input.workspace,
		sessionId: input.sessionId,
		ids,
		claim,
	});
	let ids: string[] = [];
	const entry = (
		outcome: BackgroundGateEntry["outcome"],
		exitCodes: Record<string, number | "interrupted">,
		stillRunning: readonly string[],
		error?: string,
	): BackgroundGateEntry => ({
		round: input.round,
		at: new Date(started).toISOString(),
		ids,
		waitedSeconds: Math.round((now() - started) / 100) / 10,
		outcome,
		exitCodes,
		stillRunning,
		...(error ? { error } : {}),
	});
	try {
		ids = await unnotifiedBackgroundCommandIds({
			...input.workspace,
			sessionId: input.sessionId,
		});
		if (!ids.length) return { notice: null, entry: null };
		const stopAt =
			input.deadlineAt - backgroundGateMarginMs(input.deadlineAt - started);
		let state = await observeBackgroundCommandStates(observeInput(ids, false));
		// Each command ends by its own limit (the runner's timeout); never wait past it.
		const capMs = backgroundCommandMaxSeconds() * 1000;
		const waitUntil = Math.min(
			stopAt,
			started + BACKGROUND_GATE_MAX_WAIT_MS,
			...state.running.map((command) =>
				command.startedAt ? command.startedAt + capMs + 30_000 : stopAt,
			),
		);
		// Every id is unannounced, so any exit among them is news: wake on the first one.
		while (state.running.length && !state.exits.length) {
			if (signal.aborted)
				return {
					notice: null,
					entry: entry(
						"aborted",
						{},
						state.running.map((command) => command.id),
					),
				};
			if (now() >= waitUntil)
				return {
					notice: null,
					entry: entry(
						"deadline",
						{},
						state.running.map((command) => command.id),
					),
				};
			await sleep(Math.max(0, Math.min(pollMs, waitUntil - now())), signal);
			state = await observeBackgroundCommandStates(observeInput(ids, false));
		}
		const claimed = await observeBackgroundCommandStates(
			observeInput(ids, true),
		);
		const exitCodes = Object.fromEntries(
			claimed.exits.map((exit) => [exit.id, exit.exitCode]),
		);
		const fresh = claimed.exits.filter((exit) => exit.fresh);
		const stillRunning = claimed.running.map((command) => command.id);
		if (!fresh.length)
			return { notice: null, entry: entry("seen", exitCodes, stillRunning) };
		return {
			notice: backgroundCommandNoticeMessage(fresh),
			entry: entry("notified", exitCodes, stillRunning),
		};
	} catch (error) {
		return {
			notice: null,
			entry: entry(
				"error",
				{},
				[],
				error instanceof Error ? error.message : String(error),
			),
		};
	}
}
