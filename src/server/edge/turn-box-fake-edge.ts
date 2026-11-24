import { ApiTurnCancelled } from "../../domain/api-turn-failure";
import {
	generateTurnBoxKeyPair,
	issueTurnBoxIdentity,
	TurnBoxReplayGuard,
} from "../../domain/turn-box-grant";
import type { BoxPortOp } from "../../domain/turn-box-protocol";
import type { ApiTurn } from "../adapters/api-turns";
import {
	routeTurnBoxEdge,
	type TurnBoxEdgeDeps,
	type TurnBoxEdgeOps,
} from "./turn-box-routes";

/**
 * Test double of the edge for the box API: the real routes over an in-memory
 * turn table whose lease predicate mirrors the SQL
 * (id, lease_id, state='running', not cancel_requested). Never ships.
 */
export const FAKE_TURN = {
	id: "22222222-2222-4222-8222-222222222222",
	session_id: "11111111-1111-4111-8111-111111111111",
	user_id: "user-1",
	lease_id: "33333333-3333-4333-8333-333333333333",
};

export type FakeRow = ApiTurn & {
	cancel_requested: boolean;
	updated_at: string;
	connection_kind?: string;
};

export async function fakeEdge(
	options: {
		users?: string;
		revoked?: boolean;
		bundle?: TurnBoxEdgeDeps["bundle"];
		enroll?: TurnBoxEdgeDeps["enroll"];
	} = {},
) {
	const keys = await generateTurnBoxKeyPair();
	const row: FakeRow = {
		...FAKE_TURN,
		connection_id: "conn-1",
		connection_revision: "rev-1",
		model_id: "gpt",
		state: "running",
		messages: [],
		items: [],
		cancel_requested: false,
		updated_at: "2026-11-17T00:00:00.000Z",
		run_attempts: 0,
	};
	const queue: FakeRow[] = [];
	const calls: string[] = [];
	const state = {
		revoked: options.revoked ?? false,
		reserveOk: true,
		now: 1_000_000,
		/** In-memory handlers of the turn ports (an op with none answers 501). */
		ports: {} as Partial<
			Record<
				BoxPortOp,
				(args: never, turn: ApiTurn) => Promise<unknown> | unknown
			>
		>,
	};
	const holds = (turn: ApiTurn) =>
		turn.id === row.id &&
		turn.lease_id === row.lease_id &&
		row.state === "running" &&
		!row.cancel_requested;
	const fence = (turn: ApiTurn) => {
		if (!holds(turn)) throw new Error("API turn lease was lost.");
	};
	const ops: TurnBoxEdgeOps = {
		boxActive: async () => !state.revoked,
		register: async () => !state.revoked,
		claim: async () => {
			calls.push("claim");
			return queue.shift() ?? null;
		},
		noteStarted: async () => {
			calls.push("noteStarted");
		},
		handToObject: async () => {
			calls.push("handToObject");
			row.state = "queued";
		},
		releaseClaim: async () => {
			calls.push("release");
		},
		loadOwnedIdentity: async (grant) => {
			calls.push("loadOwnedIdentity");
			return row.state === "running" &&
				row.id === grant.turnId &&
				row.lease_id === grant.leaseId &&
				row.user_id === grant.userId &&
				row.session_id === grant.sessionId
				? { ...row, messages: [], items: [] }
				: null;
		},
		loadOwned: async (grant) => {
			calls.push("loadOwned");
			return row.state === "running" &&
				row.id === grant.turnId &&
				row.lease_id === grant.leaseId &&
				row.user_id === grant.userId &&
				row.session_id === grant.sessionId
				? { ...row }
				: null;
		},
		renew: async (turn) => {
			calls.push("renew");
			return holds(turn);
		},
		checkpoint: async (turn, input) => {
			calls.push("checkpoint");
			fence(turn);
			row.messages = input.messages;
			row.items = input.items;
			row.updated_at = new Date(
				Date.parse(row.updated_at) + 1000,
			).toISOString();
		},
		progress: async (turn, items) => {
			calls.push("progress");
			fence(turn);
			row.items = items;
		},
		finalize: async (turn, input) => {
			calls.push("finalize");
			// Like finalizeApiTurn's SQL: a turn asked to stop still finalizes (as
			// cancelled); only a lease that moved, or a settled turn, is refused.
			if (
				turn.id !== row.id ||
				turn.lease_id !== row.lease_id ||
				row.state !== "running"
			)
				return null;
			row.state = row.cancel_requested ? "cancelled" : input.state;
			row.items = input.items;
			return row.state as "completed" | "failed" | "cancelled";
		},
		cancelRequested: async () => row.cancel_requested,
		reserve: async () =>
			state.reserveOk
				? { ok: true }
				: { ok: false, message: "API usage safety budget reached." },
		port: async (turn, op, args) => {
			calls.push(`port:${op}`);
			// Reads and writes are fenced like the SQL: a stale lease reaches nothing.
			fence(turn);
			const handler = state.ports[op];
			if (!handler) return { served: false };
			return { served: true, result: await handler(args as never, turn) };
		},
		authorizeModel: async () => ({
			kind: "ok",
			connectionKind: row.connection_kind ?? "key",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "sk-real",
		}),
	};
	const upstream = async () => new Response("ok");
	const deps: TurnBoxEdgeDeps = {
		publicKey: keys.publicKey,
		privateKey: keys.privateKey,
		boxUsers: new Set((options.users ?? "*").split(",")),
		ops,
		replay: new TurnBoxReplayGuard(),
		forwardSocket: async () => new Response(null, { status: 204 }),
		upstream: upstream as unknown as typeof fetch,
		// A long-polled claim looks again at once here (no real waiting in tests).
		sleep: async () => undefined,
		...(options.bundle ? { bundle: options.bundle } : {}),
		...(options.enroll ? { enroll: options.enroll } : {}),
		now: () => state.now,
		log: () => undefined,
	};
	const identity = await issueTurnBoxIdentity(
		keys.privateKey,
		{ boxId: "box-a" },
		state.now,
	);
	/** A fetch against the real routes, as a box would call the edge. */
	const fetchEdge = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await routeTurnBoxEdge(new Request(input, init), deps);
		// A real fetch inflates a gzip response; so does this one.
		if (response.headers.get("content-encoding") !== "gzip" || !response.body)
			return response;
		const headers = new Headers(response.headers);
		headers.set("x-was-gzip", "1");
		headers.delete("content-encoding");
		return new Response(
			response.body.pipeThrough(new DecompressionStream("gzip")),
			{ status: response.status, headers },
		);
	}) as typeof fetch;
	return {
		keys,
		row,
		queue,
		calls,
		state,
		deps,
		identity,
		fetchEdge,
		ops,
		ApiTurnCancelled,
	};
}
