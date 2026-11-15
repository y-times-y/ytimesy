import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { MAX_WORKFLOW_MODEL_STEPS } from "#/domain/model-workflow";
import { configuredTurnExecutor } from "#/domain/turn-executor";
import { modelConcurrencyLimits } from "../adapters/agent-capacity";
import {
	type ApiTurn,
	abandonApiTurn,
	claimApiTurn,
	readRunningApiTurn,
	requeueInterruptedBoxTurns,
} from "../adapters/api-turns";
import { withConversationProgressWake } from "../adapters/conversation-progress-wake";
import { closeDatabase } from "../adapters/database";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { listenForQueuedTurns } from "../adapters/turn-queue-wake";
import {
	registerTurnRunnerBox,
	removeTurnRunnerBox,
} from "../adapters/turn-runner-boxes";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";
import { relayConversationDeliveriesOnce } from "./conversation-delivery";
import { TurnDispatcher } from "./turn-dispatcher";

/**
 * A turn runner box (docs/turn-runner-boxes.md): runs the model loop of the
 * turns routed to it (executor 'node'), one process step after another, with
 * the chat's Durable Object only coordinating. Progress is saved to Postgres
 * after every model call and tool result (the turn's checkpoints), so a turn
 * whose box dies resumes on another from there: requeueInterruptedBoxTurns.
 */

/** A step that throws is run again this many times before the turn is failed. */
export const MAX_BOX_STEP_RETRIES = 3;
const REGISTER_EVERY_MS = 10_000;
const BACKSTOP_EVERY_MS = 5_000;
const TAKEOVER_EVERY_MS = 15_000;

/**
 * Runs one claimed turn to its end. `runApiTurn` returns "continue" when the
 * turn goes on after a step (a fallback route took over); then the turn is
 * read again. A turn taken over from a dead box starts as a resumed step: it
 * closes the tool calls the box left unanswered instead of repeating them.
 */
export async function runBoxTurn(
	machines: WorkspaceMachines,
	claimed: ApiTurn,
	deps: {
		readonly run?: typeof runApiTurn;
		readonly reread?: typeof readRunningApiTurn;
		readonly abandon?: typeof abandonApiTurn;
		readonly pause?: (ms: number) => Promise<void>;
	} = {},
) {
	const run = deps.run ?? runApiTurn;
	const reread = deps.reread ?? readRunningApiTurn;
	const abandon = deps.abandon ?? abandonApiTurn;
	const pause =
		deps.pause ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
	const leaseId = claimed.lease_id;
	if (!leaseId) return "unavailable";
	let turn = claimed;
	let resumed = (claimed.run_attempts ?? 0) > 0;
	let failures = 0;
	for (let index = 1; ; ) {
		try {
			const outcome = await withConversationProgressWake(
				() => relayConversationDeliveriesOnce(turn.session_id),
				() =>
					run(machines, turn, {
						index,
						signal: new AbortController().signal,
						limitReached: index > MAX_WORKFLOW_MODEL_STEPS,
						resumed,
						startedAt: Date.now(),
					}),
			);
			if (outcome !== "continue") return outcome;
			failures = 0;
			index++;
			resumed = false;
		} catch (error) {
			// The turn was lost to another owner, stopped, or finished: nothing to retry.
			const current = await reread(turn.id, leaseId).catch(() => null);
			if (!current) throw error;
			if (++failures > MAX_BOX_STEP_RETRIES) {
				console.warn("Box turn kept failing; turn abandoned.", { index });
				await abandon(turn.id, leaseId).catch(() => false);
				throw error;
			}
			console.warn("Box step failed; retrying.", {
				index,
				cause: error instanceof Error ? error.name : "unknown",
			});
			await pause(5_000 * failures);
			resumed = true;
		}
		const next = await reread(turn.id, leaseId);
		if (!next) return "unavailable";
		turn = next;
	}
}

export async function runTurnRunnerBox() {
	// Boxes serve a deployment whose turns run in Durable Objects; routing a
	// turn here is decided when it is queued (chooseTurnExecutor).
	if (
		configuredTurnExecutor(process.env.YTIMESY_MODEL_EXECUTION_TARGET) !==
		"durable-object"
	)
		throw new Error(
			"A turn runner box serves a deployment that runs turns in Durable Objects.",
		);
	const id = process.env.YTIMESY_TURN_BOX_ID || hostname();
	const capacity = Number(process.env.YTIMESY_TURN_BOX_CAPACITY ?? "6");
	if (!Number.isInteger(capacity) || capacity < 1 || capacity > 32)
		throw new Error("Turn box capacity must be between 1 and 32.");
	const machines = createFreestyleWorkspaceMachines(
		await Effect.runPromise(readFreestyleApiKey()),
	);
	const { perUser, fleet } = modelConcurrencyLimits();
	let running = 0;
	const dispatcher = new TurnDispatcher({
		concurrency: capacity,
		claim: () => claimApiTurn(perUser, fleet, "node"),
		run: async (turn) => {
			running++;
			try {
				await runBoxTurn(machines, turn);
			} finally {
				running--;
			}
		},
		onError: () =>
			console.warn(
				"A box turn ended with an error; the queue is checked again.",
			),
	});
	const register = () =>
		registerTurnRunnerBox({
			id,
			capacity,
			running,
			version: process.env.YTIMESY_BUILD_ID,
		}).catch(() => console.warn("Box registration deferred."));
	await register();
	const timers = [
		setInterval(() => void register(), REGISTER_EVERY_MS),
		setInterval(() => dispatcher.wake(), BACKSTOP_EVERY_MS),
		setInterval(
			() => void requeueInterruptedBoxTurns().catch(() => undefined),
			TAKEOVER_EVERY_MS,
		),
	];
	for (const timer of timers) timer.unref();
	const stopListening = listenForQueuedTurns(() => dispatcher.wake());
	dispatcher.wake();
	console.info("ytimesy turn runner box is running.", { id, capacity });
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		// No new turns are routed here; the ones running finish (or are taken
		// over by another box once their heartbeat stops).
		await removeTurnRunnerBox(id).catch(() => undefined);
		for (const timer of timers) clearInterval(timer);
		await dispatcher.drain();
		await stopListening();
		await closeDatabase();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	await runTurnRunnerBox();
}
