import { z } from "zod";
import { ApiTurnCancelled } from "../../domain/api-turn-failure";
import { readBoundedRequestBody } from "../../domain/bounded-request-body";
import {
	issueTurnBoxGrant,
	issueTurnBoxIdentity,
	presentedTurnBoxToken,
	TURN_BOX_GRANT_REFRESH_MS,
	TURN_BOX_IDENTITY_REFRESH_MS,
	type TurnBoxGrant,
	type TurnBoxReplayGuard,
	verifyTurnBoxGrant,
	verifyTurnBoxIdentity,
} from "../../domain/turn-box-grant";
import {
	proxyTurnBoxModel,
	type TurnBoxModelAuthorization,
} from "../../domain/turn-box-model-proxy";
import {
	type BoxPortOp,
	boxPortArgs,
	checkpointRequest,
	claimRequest,
	finalizeRequest,
	historyRequest,
	portRequest,
	progressRequest,
	registerRequest,
	reserveRequest,
	TURN_BOX_API_PREFIX,
	TURN_BOX_MAX_BODY_BYTES,
	TURN_BOX_MAX_HISTORY_BYTES,
	TURN_BOX_PATHS,
	TurnBoxPortForbidden,
	type TurnBoxTurnIdentity,
} from "../../domain/turn-box-protocol";
import { boxTurnUsers } from "../../domain/turn-executor";
import type { ApiTurn } from "../adapters/api-turns";
import {
	isTurnBoxVmPath,
	releaseTurnBoxVmIdentity,
	routeTurnBoxVm,
	type TurnBoxVmOps,
} from "./turn-box-vm-routes";

/**
 * The edge half of the thin-client API for turn runner boxes
 * (docs/turn-runner-boxes.md). Off (404) unless YTIMESY_BOX_TURN_USERS names
 * someone. Every turn endpoint is authenticated by a signed per-turn grant
 * and acts only on the turn row the grant names, through the same
 * lease-checked writers the Durable Object uses (api-turns.ts); nothing here
 * writes SQL of its own. The box's secrets are never needed: the edge holds
 * the database, the vault and the signing key.
 */
export interface TurnBoxEdgeOps {
	/** The box is known to the edge and not revoked (turn_runner_box). */
	boxActive(boxId: string): Promise<boolean>;
	/** Registers/heartbeats the box; false when it has been revoked. */
	register(
		boxId: string,
		input: { capacity: number; running: number; version?: string },
	): Promise<boolean>;
	claim(perUserLimit?: number): Promise<ApiTurn | null>;
	releaseClaim(turnId: string, leaseId: string): Promise<void>;
	/**
	 * The turn the grant names while it is running under the grant's lease
	 * (id, lease_id, state='running'), and only if it is the grant's user's
	 * chat; null otherwise.
	 */
	loadOwned(grant: TurnBoxGrant): Promise<ApiTurn | null>;
	renew(turn: ApiTurn): Promise<boolean>;
	checkpoint(
		turn: ApiTurn,
		input: z.infer<typeof checkpointRequest>,
	): Promise<void>;
	progress(
		turn: ApiTurn,
		items: z.infer<typeof progressRequest>["items"],
	): Promise<void>;
	finalize(
		turn: ApiTurn,
		input: z.infer<typeof finalizeRequest>,
	): Promise<"completed" | "failed" | "cancelled" | null>;
	cancelRequested(turn: ApiTurn): Promise<boolean>;
	reserve(
		grant: Pick<TurnBoxGrant, "userId" | "sessionId">,
		tokens: number,
	): Promise<{ ok: boolean; message?: string }>;
	authorizeModel(grant: TurnBoxGrant): Promise<TurnBoxModelAuthorization>;
	/**
	 * One turn port (turn-box-protocol.ts `boxPortArgs`) for the turn the grant
	 * names; `args` are already validated. `served: false` when this edge has no
	 * handler for the op (answered 501). Handlers take the user, chat and turn
	 * from the turn row, never from `args`.
	 */
	port(
		turn: ApiTurn,
		op: BoxPortOp,
		args: unknown,
	): Promise<{ served: true; result: unknown } | { served: false }>;
}

/** Where a box downloads its program: gzip, checked against `sha256` of the inflated file. */
export type TurnBoxBundle = {
	readonly url: string;
	readonly sha256: string;
	readonly version: string;
};

export type TurnBoxEdgeDeps = {
	readonly publicKey: string;
	readonly privateKey: string;
	readonly boxUsers: ReadonlySet<string>;
	readonly ops: TurnBoxEdgeOps;
	readonly replay: TurnBoxReplayGuard;
	/** Hands a verified socket upgrade to the chat's Durable Object. */
	readonly forwardSocket: (
		grant: TurnBoxGrant,
		request: Request,
	) => Promise<Response>;
	/** Counts one Worker request for the user's budget meter (optional). */
	readonly countRequest?: (userId: string | null) => void;
	/** The `vm/*` endpoints (turn-box-vm-routes.ts); absent: they answer 404. */
	readonly vm?: TurnBoxVmOps;
	/**
	 * Who STS says signed an enrollment request (its instance id), or null;
	 * absent: enrollment is off (docs/turn-runner-boxes.md, "Enrollment").
	 */
	readonly enroll?: (headers: unknown) => Promise<string | null>;
	/** The box program to download (a short-lived link and its checksum); absent: none is served. */
	readonly bundle?: () => Promise<TurnBoxBundle | null>;
	readonly upstream?: typeof fetch;
	readonly now?: () => number;
	readonly log?: (message: string, detail: Record<string, unknown>) => void;
};

const edgeSecrets = z.object({
	TURN_BOX_EDGE_PRIVATE_KEY: z.string().min(40),
	TURN_BOX_EDGE_PUBLIC_KEY: z.string().min(40),
});

/** The configured keys and users, or null while the feature is off or half-configured. */
export function turnBoxEdgeConfig(
	env: Record<string, unknown>,
	flag: string | undefined = typeof env.YTIMESY_BOX_TURN_USERS === "string"
		? env.YTIMESY_BOX_TURN_USERS
		: process.env.YTIMESY_BOX_TURN_USERS,
) {
	const boxUsersSet = boxTurnUsers(flag);
	if (boxUsersSet.size === 0) return { status: 404 as const };
	const secrets = edgeSecrets.safeParse(env);
	if (!secrets.success) return { status: 503 as const };
	return {
		status: 200 as const,
		publicKey: secrets.data.TURN_BOX_EDGE_PUBLIC_KEY,
		privateKey: secrets.data.TURN_BOX_EDGE_PRIVATE_KEY,
		boxUsers: boxUsersSet,
	};
}

export function isTurnBoxEdgePath(path: string) {
	return (
		path === TURN_BOX_API_PREFIX || path.startsWith(`${TURN_BOX_API_PREFIX}/`)
	);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refuse = (
	error:
		| "unauthorized"
		| "forbidden"
		| "lease-lost"
		| "bad-request"
		| "too-large"
		| "unavailable"
		| "not-served",
	status: number,
) => json({ error }, status);

/** Largest clock difference accepted on a claim (replay window). */
const CLAIM_SKEW_MS = 60_000;

async function gzip(text: string) {
	const stream = new Blob([text])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Response(stream).arrayBuffer();
}

export async function routeTurnBoxEdge(
	request: Request,
	deps: TurnBoxEdgeDeps,
): Promise<Response> {
	const now = deps.now ?? Date.now;
	const log = deps.log ?? ((m, d) => console.warn(m, d));
	const path = new URL(request.url).pathname;
	const drop = () => request.body?.cancel().catch(() => undefined);

	// An EC2 box's first call: proof of its instance role (STS), answered with an
	// identity for that instance. A revoked instance id is refused.
	if (path === TURN_BOX_PATHS.enroll) {
		if (!deps.enroll) {
			await drop();
			return new Response(null, { status: 404 });
		}
		if (request.method !== "POST") return new Response(null, { status: 405 });
		deps.countRequest?.(null);
		const body = await readJson(request);
		if (body === undefined) return refuse("too-large", 413);
		try {
			const boxId = await deps.enroll(
				(body as { headers?: unknown } | null)?.headers,
			);
			if (!boxId) return refuse("unauthorized", 401);
			if (!(await deps.ops.boxActive(boxId))) return refuse("forbidden", 403);
			return Response.json(
				{
					identity: await issueTurnBoxIdentity(
						deps.privateKey,
						{ boxId },
						now(),
					),
				},
				{ headers: { "cache-control": "no-store" } },
			);
		} catch {
			log("Turn box enrollment failed.", { path });
			return refuse("unavailable", 503);
		}
	}

	// A new box's program: by identity alone, so a box can start before it has
	// registered. A revoked box is given nothing.
	if (path === TURN_BOX_PATHS.bundle) {
		if (request.method !== "GET") return new Response(null, { status: 405 });
		const identity = await verifyTurnBoxIdentity(
			deps.publicKey,
			presentedTurnBoxToken(request.headers),
			now(),
		);
		deps.countRequest?.(null);
		if (!identity) return refuse("unauthorized", 401);
		try {
			if (!(await deps.ops.boxActive(identity.boxId)))
				return refuse("forbidden", 403);
			const bundle = await deps.bundle?.();
			return bundle ? json(bundle) : refuse("not-served", 404);
		} catch {
			log("Turn box bundle request failed.", { path });
			return refuse("unavailable", 503);
		}
	}

	// Box identity endpoints.
	if (path === TURN_BOX_PATHS.claim || path === TURN_BOX_PATHS.register) {
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const identity = await verifyTurnBoxIdentity(
			deps.publicKey,
			presentedTurnBoxToken(request.headers),
			now(),
		);
		deps.countRequest?.(null);
		if (!identity) {
			await drop();
			return refuse("unauthorized", 401);
		}
		const body = await readJson(request);
		if (body === undefined) return refuse("too-large", 413);
		try {
			if (path === TURN_BOX_PATHS.register) {
				const input = registerRequest.safeParse(body);
				if (!input.success) return refuse("bad-request", 400);
				const { refreshIdentity, ...heartbeat } = input.data;
				if (!(await deps.ops.register(identity.boxId, heartbeat)))
					return refuse("forbidden", 403);
				if (!refreshIdentity) return json({ ok: true });
				const signingTime = now();
				const remaining = identity.expiresAt - signingTime;
				if (remaining <= 0) return refuse("unauthorized", 401);
				if (remaining > TURN_BOX_IDENTITY_REFRESH_MS) return json({ ok: true });
				const replacement = await issueTurnBoxIdentity(
					deps.privateKey,
					{ boxId: identity.boxId },
					signingTime,
				);
				return Response.json(
					{ ok: true, identity: replacement },
					{ headers: { "cache-control": "no-store" } },
				);
			}
			const input = claimRequest.safeParse(body);
			if (!input.success) return refuse("bad-request", 400);
			// A claim is single-use: fresh timestamp and a nonce never seen.
			const nonce = request.headers.get("x-ytimesy-nonce") ?? "";
			const stamp = Number(request.headers.get("x-ytimesy-ts"));
			if (
				!/^[a-f0-9]{16,64}$/.test(nonce) ||
				!Number.isFinite(stamp) ||
				Math.abs(now() - stamp) > CLAIM_SKEW_MS ||
				!deps.replay.consume(
					`claim:${identity.boxId}:${nonce}`,
					now() + 2 * CLAIM_SKEW_MS,
					now(),
				)
			)
				return refuse("unauthorized", 401);
			if (!(await deps.ops.boxActive(identity.boxId)))
				return refuse("forbidden", 403);
			const turn = await deps.ops.claim(input.data.perUserLimit);
			if (!turn) return new Response(null, { status: 204 });
			const leaseId = turn.lease_id;
			if (
				!leaseId ||
				!(deps.boxUsers.has("*") || deps.boxUsers.has(turn.user_id))
			) {
				// Not enabled for this user: back to the queue, not a stranded turn.
				if (leaseId)
					await deps.ops.releaseClaim(turn.id, leaseId).catch(() => undefined);
				return new Response(null, { status: 204 });
			}
			const grant = await issueTurnBoxGrant(
				deps.privateKey,
				{
					userId: turn.user_id,
					sessionId: turn.session_id,
					turnId: turn.id,
					leaseId,
					boxId: identity.boxId,
				},
				now(),
			);
			const verified = await verifyTurnBoxGrant(deps.publicKey, grant, now());
			return json({
				turn: identityOf(turn, leaseId),
				grant,
				grantExpiresAt: verified?.expiresAt ?? now(),
			});
		} catch {
			log("Turn box edge identity request failed.", { path });
			return refuse("unavailable", 503);
		}
	}

	// Grant endpoints.
	const grant = await verifyTurnBoxGrant(
		deps.publicKey,
		presentedTurnBoxToken(request.headers) ??
			request.headers.get("x-api-key") ??
			request.headers.get("x-goog-api-key"),
		now(),
	);
	deps.countRequest?.(grant?.userId ?? null);
	if (path.startsWith(`${TURN_BOX_PATHS.model}/`)) {
		return proxyTurnBoxModel(request, {
			publicKey: deps.publicKey,
			now: now(),
			upstream: deps.upstream,
			log,
			// The step's prompt tokens, as the loop reserves them (about
			// bytes / 3 plus 24k for the reply), taken here so a model call needs
			// no separate reserve request.
			reserve: async (verified, bytes) =>
				(await deps.ops.reserve(verified, Math.ceil(bytes / 3) + 24_000)).ok,
			authorize: async (verified) =>
				(await deps.ops.boxActive(verified.boxId))
					? deps.ops.authorizeModel(verified)
					: { kind: "refused", status: 403 },
		});
	}
	if (!grant) {
		await drop();
		return refuse("unauthorized", 401);
	}
	if (path === TURN_BOX_PATHS.socket) {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
			return new Response(null, { status: 426 });
		return deps.forwardSocket(grant, request);
	}

	if (isTurnBoxVmPath(path)) {
		if (!deps.vm) {
			await drop();
			return new Response(null, { status: 404 });
		}
		return routeTurnBoxVm(request, grant, {
			boxUsers: deps.boxUsers,
			ops: deps.ops,
			vm: deps.vm,
			log,
		});
	}

	const routes = new Set<string>([
		TURN_BOX_PATHS.renew,
		TURN_BOX_PATHS.checkpoint,
		TURN_BOX_PATHS.progress,
		TURN_BOX_PATHS.finalize,
		TURN_BOX_PATHS.history,
		TURN_BOX_PATHS.reserve,
		TURN_BOX_PATHS.cancel,
		TURN_BOX_PATHS.port,
	]);
	if (!routes.has(path) || request.method !== "POST") {
		await drop();
		return new Response(null, { status: 404 });
	}
	const body = await readJson(request);
	if (body === undefined) return refuse("too-large", 413);
	try {
		// The lease check every endpoint starts with: the turn must be running
		// under exactly the grant's lease and belong to the grant's user and chat.
		const turn = await deps.ops.loadOwned(grant);
		if (!turn) return refuse("lease-lost", 409);

		if (path === TURN_BOX_PATHS.renew) {
			if (!(await deps.ops.boxActive(grant.boxId)))
				return refuse("forbidden", 403);
			const renewed = await deps.ops.renew(turn);
			if (!renewed)
				return json({
					renewed: false,
					cancelRequested: await deps.ops.cancelRequested(turn),
					inbox: false,
				});
			let replacement: { grant: string; grantExpiresAt: number } | undefined;
			// One replacement per grant: a replayed grant gets the renewal but no new life.
			if (
				grant.expiresAt - now() < TURN_BOX_GRANT_REFRESH_MS &&
				deps.replay.consume(`grant:${grant.nonce}`, grant.expiresAt, now())
			) {
				const next = await issueTurnBoxGrant(deps.privateKey, grant, now());
				const parsed = await verifyTurnBoxGrant(deps.publicKey, next, now());
				if (parsed)
					replacement = { grant: next, grantExpiresAt: parsed.expiresAt };
			}
			return json({
				renewed: true,
				cancelRequested: false,
				inbox: false,
				...replacement,
			});
		}
		if (path === TURN_BOX_PATHS.cancel) {
			const stopped = await deps.ops.cancelRequested(turn);
			// Stop: the turn's scoped VM identity goes with it.
			if (stopped) await releaseTurnBoxVmIdentity(deps.vm, turn);
			return json({ cancelRequested: stopped });
		}
		if (path === TURN_BOX_PATHS.port) {
			// A revoked box reaches nothing, whatever lease it still holds.
			if (!(await deps.ops.boxActive(grant.boxId)))
				return refuse("forbidden", 403);
			const call = portRequest.safeParse(body);
			if (!call.success || !Object.hasOwn(boxPortArgs, call.data.op))
				return refuse("bad-request", 400);
			const op = call.data.op as BoxPortOp;
			const args = boxPortArgs[op].safeParse(call.data.args ?? {});
			if (!args.success) return refuse("bad-request", 400);
			try {
				const done = await deps.ops.port(turn, op, args.data);
				return done.served
					? json({ ok: true, result: done.result ?? null })
					: refuse("not-served", 501);
			} catch (error) {
				if (error instanceof ApiTurnCancelled)
					return json({ ok: false, reason: "cancelled" }, 409);
				if (error instanceof TurnBoxPortForbidden)
					return refuse("forbidden", 403);
				if (error instanceof Error && /lease was lost/i.test(error.message))
					return json({ ok: false, reason: "lease-lost" }, 409);
				throw error;
			}
		}

		if (path === TURN_BOX_PATHS.history) {
			const input = historyRequest.safeParse(body);
			if (!input.success) return refuse("bad-request", 400);
			const version = versionOf(turn);
			if (input.data.version === version)
				return json({ notModified: true, version });
			const text = JSON.stringify({
				notModified: false,
				version,
				messages: turn.messages ?? [],
				items: turn.items ?? [],
			});
			if (text.length > TURN_BOX_MAX_HISTORY_BYTES)
				return refuse("too-large", 413);
			return new Response(await gzip(text), {
				headers: {
					"content-type": "application/json",
					"content-encoding": "gzip",
					"cache-control": "no-store",
				},
			});
		}
		if (path === TURN_BOX_PATHS.reserve) {
			const input = reserveRequest.safeParse(body);
			if (!input.success) return refuse("bad-request", 400);
			const reserved = await deps.ops.reserve(grant, input.data.tokens);
			return json(
				reserved.ok
					? { ok: true }
					: { ok: false, reason: "budget", message: reserved.message },
				reserved.ok ? 200 : 429,
			);
		}

		// Writes. The writers' SQL repeats the lease predicate (where id=$1 and
		// lease_id=$2 and state='running' and fresh), so a turn that changed
		// owner between the load above and the write is still refused.
		const failed = async () =>
			(await deps.ops.cancelRequested(turn))
				? json({ ok: false, reason: "cancelled" }, 409)
				: json({ ok: false, reason: "lease-lost" }, 409);
		try {
			if (path === TURN_BOX_PATHS.checkpoint) {
				const input = checkpointRequest.safeParse(body);
				if (!input.success) return refuse("bad-request", 400);
				await deps.ops.checkpoint(turn, input.data);
				// A checkpoint is proof of life: it renews the lease too (one more
				// statement at the edge, no Worker request), so the box skips its
				// own renewal right after one.
				const renewed = await deps.ops.renew(turn).catch(() => false);
				return json({ ok: true, renewed });
			}
			if (path === TURN_BOX_PATHS.progress) {
				const input = progressRequest.safeParse(body);
				if (!input.success) return refuse("bad-request", 400);
				await deps.ops.progress(turn, input.data.items);
				return json({ ok: true });
			}
			const input = finalizeRequest.safeParse(body);
			if (!input.success) return refuse("bad-request", 400);
			const state = await deps.ops.finalize(turn, input.data);
			if (state !== null) await releaseTurnBoxVmIdentity(deps.vm, turn);
			return state === null
				? json({ ok: false, reason: "lease-lost", state: null }, 409)
				: json({ ok: true, state });
		} catch (error) {
			if (error instanceof ApiTurnCancelled)
				return json({ ok: false, reason: "cancelled" }, 409);
			if (error instanceof Error && /lease was lost/i.test(error.message))
				return failed();
			throw error;
		}
	} catch {
		log("Turn box edge request failed.", { path });
		return refuse("unavailable", 503);
	}
}

function identityOf(turn: ApiTurn, leaseId: string): TurnBoxTurnIdentity {
	return {
		id: turn.id,
		session_id: turn.session_id,
		user_id: turn.user_id,
		connection_id: turn.connection_id,
		connection_revision: turn.connection_revision,
		model_id: turn.model_id,
		lease_id: leaseId,
		settings: turn.settings,
		failover: turn.failover,
		run_attempts: turn.run_attempts ?? 0,
	};
}

/** The row's version for the box's cache: its last write (updated_at). */
export function versionOf(turn: ApiTurn) {
	const value = (turn as { updated_at?: unknown }).updated_at;
	if (value instanceof Date) return value.toISOString();
	return typeof value === "string" ? value : "0";
}

/** The JSON body, `{}` when empty, or undefined when it is over the limit. */
async function readJson(request: Request): Promise<unknown> {
	try {
		const text = await readBoundedRequestBody(request, TURN_BOX_MAX_BODY_BYTES);
		return text ? JSON.parse(text) : {};
	} catch (error) {
		return error instanceof SyntaxError ? null : undefined;
	}
}
