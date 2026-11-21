import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import { MAX_WORKFLOW_MODEL_STEPS } from "#/domain/model-workflow";
import { configuredTurnExecutor } from "#/domain/turn-executor";
import type { ApiTurn } from "../adapters/api-turns";
import type { GuestExec } from "../claude-box-tools/identity-machines";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";
import { assertTurnBoxHoldsNoSecrets } from "./box-secrets-guard";
import {
	TurnBoxEdgeClient,
	TurnBoxIdentityRejected,
	TurnBoxLeaseLost,
	type TurnBoxTurnSession,
} from "./turn-box-client";
import { boxTurnPorts } from "./turn-box-ports";
import {
	type BoxWorkspaceMachines,
	boxWorkspaceMachines,
	turnBoxVmEdgeClient,
} from "./turn-box-vm-machines";
import { boxApiTurnWorkspace } from "./turn-box-workspace";
import { TurnDispatcher } from "./turn-dispatcher";
import type { TurnPorts } from "./turn-ports";

/**
 * A turn runner box (docs/turn-runner-boxes.md): runs the model loop of the
 * turns routed to it, one process step after another, with the chat's
 * Durable Object only coordinating. It is a thin client of the edge: it
 * claims through the edge's claim endpoint, and `runApiTurn` gets
 * `boxTurnPorts` (turn-box-ports.ts), so every read and write goes through
 * the edge's lease-checked API. The box holds no database URL, provider key
 * or vault key, and refuses to start when its environment holds one
 * (box-secrets-guard.ts). Progress is saved by the edge after every model
 * call and tool result (checkpoints), so a turn whose box dies resumes on
 * another: the edge's lease sweep requeues it (requeueInterruptedBoxTurns).
 */

/** A step that throws is run again this many times before the turn is failed. */
export const MAX_BOX_STEP_RETRIES = 3;
const REGISTER_EVERY_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;

/**
 * Runs one claimed turn to its end. `runApiTurn` returns "continue" when the
 * turn goes on after a step (a fallback route took over); then the turn is
 * read again. A turn taken over from a dead box starts as a resumed step: it
 * closes the tool calls the box left unanswered instead of repeating them.
 * The dependencies are required: the box supplies edge-backed ones
 * (`edgeTurnDeps`), a test supplies fakes.
 */
export async function runBoxTurn(
	machines: WorkspaceMachines,
	claimed: ApiTurn,
	deps: {
		readonly run: typeof runApiTurn;
		/** The turn again, or null when it is no longer this lease's (stopped, finished, taken over). */
		readonly reread: (
			turnId: string,
			leaseId: string,
			/** "failed": a step threw, so ask the edge whether the lease is still ours. */
			why?: "next-step" | "failed",
		) => Promise<ApiTurn | null>;
		/** Fails the turn (it kept failing); true when this lease still held it. */
		readonly abandon: (turnId: string, leaseId: string) => Promise<boolean>;
		readonly pause?: (ms: number) => Promise<void>;
	},
) {
	const { run, reread, abandon } = deps;
	const pause =
		deps.pause ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
	const leaseId = claimed.lease_id;
	if (!leaseId) return "unavailable";
	let turn = claimed;
	let resumed = (claimed.run_attempts ?? 0) > 0;
	let failures = 0;
	for (let index = 1; ; ) {
		try {
			const outcome = await run(machines, turn, {
				index,
				signal: new AbortController().signal,
				limitReached: index > MAX_WORKFLOW_MODEL_STEPS,
				resumed,
				startedAt: Date.now(),
			});
			if (outcome !== "continue") return outcome;
			failures = 0;
			index++;
			resumed = false;
		} catch (error) {
			// The turn was lost to another owner, stopped, or finished: nothing to retry.
			const current = await reread(turn.id, leaseId, "failed").catch(
				() => null,
			);
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

/** The turn row a step runs on, from the claim's identity and the edge's saved history. */
export function turnFromSession(
	session: TurnBoxTurnSession,
	history: { messages: ApiTurn["messages"]; items: ApiTurn["items"] },
): ApiTurn {
	const turn = session.turn;
	return {
		id: turn.id,
		session_id: turn.session_id,
		user_id: turn.user_id,
		connection_id: turn.connection_id,
		connection_revision: turn.connection_revision,
		model_id: turn.model_id,
		state: "running",
		messages: history.messages,
		items: history.items,
		lease_id: turn.lease_id,
		settings: turn.settings,
		failover: turn.failover,
		run_attempts: turn.run_attempts,
	};
}

/** `runBoxTurn`'s dependencies over a claimed turn's edge session: no database. */
export function edgeTurnDeps(
	session: TurnBoxTurnSession,
	ports: TurnPorts,
	run: typeof runApiTurn = runApiTurn,
) {
	return {
		run: ((machines, turn, step) =>
			run(machines, turn, step, ports)) as typeof runApiTurn,
		reread: async (
			_turnId: string,
			_leaseId: string,
			why?: "next-step" | "failed",
		) => {
			try {
				// What this box last saved is the turn's history (nobody else
				// writes it under this lease): no request between steps. After a
				// failed step the edge is asked (lease lost or stopped ends it).
				const history =
					(why !== "failed" ? session.savedHistory() : null) ??
					(await session.history());
				return turnFromSession(session, history);
			} catch (error) {
				// Lease lost (409/401), stopped, or the edge is unreachable.
				if (
					error instanceof TurnBoxLeaseLost ||
					error instanceof ApiTurnCancelled
				)
					return null;
				throw error;
			}
		},
		abandon: async () => {
			try {
				const history = await session.history();
				return (await session.finalize("failed", history.items)) !== null;
			} catch {
				return false;
			}
		},
	};
}

/**
 * The turn's workspace machines on a real box: `boxWorkspaceMachines` over
 * the edge's `vm/*` endpoints with THIS turn's grant (read per call, it is
 * renewed) and the turn's scoped Freestyle identity for guest calls. One
 * `vm/ensure` per turn happens on first use; tool calls go straight to the VM.
 */
export function edgeWorkspaceMachines(input: {
	readonly edgeUrl: string;
	readonly session: TurnBoxTurnSession;
	readonly fetch?: typeof fetch;
	readonly guest?: (grant: {
		readonly vm: string;
		readonly token: string;
		readonly linuxUser: string;
	}) => GuestExec;
}): BoxWorkspaceMachines {
	const guest =
		input.guest ??
		((grant) => {
			let exec: GuestExec | undefined;
			return async (options) => {
				exec ??= (await import("./turn-box-vm-guest")).freestyleScopedGuest(
					grant,
				);
				return exec(options);
			};
		});
	return boxWorkspaceMachines({
		edge: turnBoxVmEdgeClient({
			baseUrl: input.edgeUrl.replace(/\/$/, ""),
			grant: () => input.session.grant,
			...(input.fetch ? { fetch: input.fetch } : {}),
		}),
		guest,
	});
}

export type TurnRunnerBoxOptions = {
	/**
	 * Tests only: machines shared by every turn. A real box leaves this unset
	 * and gets `edgeWorkspaceMachines` per turn (its own grant; no Freestyle
	 * account key anywhere).
	 */
	readonly machines?: WorkspaceMachines;
	readonly machinesFor?: (
		session: TurnBoxTurnSession,
	) => WorkspaceMachines & { readonly release?: () => Promise<void> };
	readonly fetch?: typeof fetch;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly client?: TurnBoxEdgeClient;
	readonly run?: typeof runApiTurn;
	readonly signalHandlers?: boolean;
};

export async function runTurnRunnerBox(options: TurnRunnerBoxOptions = {}) {
	const env = options.env ?? process.env;
	// A box with secrets in its environment must fail loudly, before anything else.
	assertTurnBoxHoldsNoSecrets(env);
	// Boxes serve a deployment whose turns run in Durable Objects; routing a
	// turn here is decided when it is queued (chooseTurnExecutor).
	if (
		configuredTurnExecutor(env.YTIMESY_MODEL_EXECUTION_TARGET) !==
		"durable-object"
	)
		throw new Error(
			"A turn runner box serves a deployment that runs turns in Durable Objects.",
		);
	const edgeUrl = env.YTIMESY_EDGE_URL;
	const identity = env.YTIMESY_BOX_IDENTITY;
	if (!options.client && (!edgeUrl || !identity))
		throw new Error(
			"A turn runner box needs YTIMESY_EDGE_URL and YTIMESY_BOX_IDENTITY (its only credential).",
		);
	const client =
		options.client ??
		new TurnBoxEdgeClient({
			edgeUrl: edgeUrl as string,
			identity: identity as string,
		});
	const id = env.YTIMESY_TURN_BOX_ID || hostname();
	const capacity = Number(env.YTIMESY_TURN_BOX_CAPACITY ?? "6");
	if (!Number.isInteger(capacity) || capacity < 1 || capacity > 32)
		throw new Error("Turn box capacity must be between 1 and 32.");
	const pollMs = Math.max(
		1_000,
		Number(env.YTIMESY_TURN_BOX_POLL_MS ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS,
	);
	let running = 0;
	let revoked = false;
	const dispatcher = new TurnDispatcher({
		concurrency: capacity,
		// Claimed through the edge (identity + nonce), never from a database.
		claim: async () => (revoked ? null : client.claim()),
		run: async (session) => {
			running++;
			// The box's ports, with the workspace the edge's vm/ensure prepared.
			const ports = Object.assign(
				{ ...boxTurnPorts(session) },
				{ deferredApiTurnWorkspace: boxApiTurnWorkspace },
			);
			const machines =
				options.machinesFor?.(session) ??
				options.machines ??
				edgeWorkspaceMachines({
					edgeUrl: edgeUrl as string,
					session,
					...(options.fetch ? { fetch: options.fetch } : {}),
				});
			let settled = false;
			try {
				await session.openSocket();
				const history = await session.history();
				const outcome = await runBoxTurn(
					machines,
					turnFromSession(session, history),
					edgeTurnDeps(session, ports, options.run),
				);
				settled =
					outcome === "completed" ||
					outcome === "failed" ||
					outcome === "cancelled";
			} finally {
				await ports.flush().catch(() => undefined);
				// finalize and a reported Stop delete the turn's VM identity at the
				// edge; any other end (an error, a lost lease) asks it to now.
				if (!settled && "release" in machines)
					await (machines as BoxWorkspaceMachines)
						.release()
						.catch(() => undefined);
				running--;
			}
		},
		onError: () =>
			console.warn(
				"A box turn ended with an error; the queue is checked again.",
			),
	});
	const register = async () => {
		try {
			if (
				!(await client.register({
					capacity,
					running,
					version: env.YTIMESY_BUILD_ID,
				}))
			) {
				revoked = true;
				console.error("This turn runner box was revoked; no new turns.");
			}
		} catch (error) {
			console.warn(
				error instanceof TurnBoxIdentityRejected
					? error.message
					: "Box registration deferred.",
			);
		}
	};
	await register();
	const timers = [
		setInterval(() => void register(), REGISTER_EVERY_MS),
		// Polling the edge costs a Worker request per claim: no database
		// LISTEN/NOTIFY wake exists for a box.
		setInterval(() => dispatcher.wake(), pollMs),
	];
	for (const timer of timers) timer.unref();
	dispatcher.wake();
	console.info("ytimesy turn runner box is running.", { id, capacity });
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		// No new claims; the turns running finish (or are taken over by another
		// box once their lease lapses). Registration simply stops renewing.
		for (const timer of timers) clearInterval(timer);
		await dispatcher.drain();
		process.exit(0);
	};
	if (options.signalHandlers !== false) {
		process.on("SIGINT", () => void stop());
		process.on("SIGTERM", () => void stop());
	}
	return { stop, dispatcher };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	await runTurnRunnerBox();
}
