import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { readBoundedRequestBody } from "../domain/bounded-request-body";
import {
	type ConversationSnapshot,
	conversationEvent,
	conversationSnapshotSchema,
	MAX_DELIVERY_BYTES,
} from "../domain/conversation-delivery";
import {
	type ActiveConversationTurn,
	conversationPurgeSchema,
	TURN_COORDINATION_LEASE_MS,
	turnControlSchema,
} from "../domain/conversation-turn-control";
import { verifyDeliveryRequest } from "../domain/delivery-auth";

type RealtimeEnvironment = {
	CONVERSATIONS: DurableObjectNamespace;
	DELIVERY_SECRET: string;
};
const encoder = new TextEncoder();
type SnapshotHead = { revision: string; chunks: number };

// This narrow storage port works with both workers-types and Wrangler's generated
// runtime declarations without coupling chat state to either SDK's full global types.
interface ConversationStorage {
	get<T>(key: string): Promise<T | undefined>;
	get<T>(keys: string[]): Promise<Map<string, T>>;
	put(key: string, value: unknown): Promise<void>;
	put(entries: Record<string, unknown>): Promise<void>;
	delete(key: string): Promise<boolean>;
	deleteAll?(): Promise<void>;
	deleteAlarm(): Promise<void>;
	setAlarm(time: number): Promise<void>;
}
interface ConversationRoomState {
	storage: ConversationStorage & {
		transaction<T>(
			run: (storage: ConversationStorage) => Promise<T>,
		): Promise<T>;
	};
	blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
}

async function boundedBody(request: Request) {
	return readBoundedRequestBody(request, MAX_DELIVERY_BYTES);
}

/** The tombstone a purged chat's object keeps; see ConversationRoom.purge. */
const PURGED_KEY = "purged";

/** One current snapshot per conversation; PG remains the transcript and inference authority. */
export class ConversationRoom {
	private latest: ConversationSnapshot | null = null;
	/**
	 * Set once the chat was deleted: the stored tombstone refuses every later
	 * write (a snapshot, turn control, an in-flight turn's renewal, an alarm),
	 * so nothing recreates the chat's state after its purge.
	 */
	private purged = false;
	private readonly subscribers = new Set<
		(snapshot: ConversationSnapshot) => void
	>();
	/**
	 * `schedule` lets a host object that also uses the alarm (the chat DO's turn
	 * loop) multiplex it; by default the room owns the alarm.
	 */
	private readonly schedule: (at: number | null) => Promise<void>;
	constructor(
		private readonly state: ConversationRoomState,
		// The realtime Worker instantiates this class as a Durable Object, passing its env here.
		schedule?: unknown,
	) {
		this.schedule =
			typeof schedule === "function"
				? (schedule as (at: number | null) => Promise<void>)
				: (at) =>
						at === null
							? state.storage.deleteAlarm()
							: state.storage.setAlarm(at);
		state.blockConcurrencyWhile(async () => {
			const [purged, head] = await Promise.all([
				state.storage.get<boolean>(PURGED_KEY),
				state.storage.get<SnapshotHead>("head"),
			]);
			if (purged === true) {
				this.purged = true;
				return;
			}
			if (!head) return;
			const keys = Array.from(
				{ length: head.chunks },
				(_, index) => `snapshot:${index}`,
			);
			const stored = await state.storage.get<string>(keys);
			const text = keys
				.map((key) => {
					const chunk = stored.get(key);
					if (chunk === undefined)
						throw new Error("Incomplete delivery snapshot.");
					return chunk;
				})
				.join("");
			this.latest = conversationSnapshotSchema.parse(JSON.parse(text));
		});
	}
	/**
	 * Deletes the object's stored state and leaves only the tombstone; from
	 * now on the room refuses every write. The host deletes its own state and
	 * the alarm first. Idempotent.
	 */
	async purge() {
		this.purged = true;
		this.latest = null;
		await this.state.storage.deleteAll?.();
		await this.state.storage.put(PURGED_KEY, true);
	}
	get isPurged() {
		return this.purged;
	}
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// The standalone realtime Worker's room owns all of its object's storage.
		if (url.pathname === "/purge") {
			this.purged = true;
			await this.state.storage.deleteAlarm();
			await this.purge();
			return new Response(null, { status: 204 });
		}
		if (this.purged) return new Response(null, { status: 410 });
		if (url.pathname.startsWith("/turn/")) return this.controlTurn(request);
		if (request.method === "POST") {
			const incoming = conversationSnapshotSchema.parse(await request.json());
			if (incoming.sessionId !== incoming.progress.sessionId)
				return new Response(null, { status: 400 });
			if (
				this.latest &&
				(this.latest.userId !== incoming.userId ||
					this.latest.sessionId !== incoming.sessionId)
			)
				return new Response(null, { status: 403 });
			if (
				!this.latest ||
				BigInt(incoming.revision) > BigInt(this.latest.revision)
			) {
				const written = await this.state.storage.transaction(
					async (transaction) => {
						// A purge that ran while this request awaited wins.
						if (this.purged) return false;
						const current = await transaction.get<SnapshotHead>("head");
						if (
							!current ||
							BigInt(incoming.revision) > BigInt(current.revision)
						) {
							const text = JSON.stringify(incoming);
							const chunks = Math.ceil(text.length / 128_000);
							const entries: Record<string, unknown> = {
								head: { revision: incoming.revision, chunks },
							};
							// Each entry stays below the platform's 2 MiB key/value limit.
							for (let index = 0; index < chunks; index++)
								entries[`snapshot:${index}`] = text.slice(
									index * 128_000,
									(index + 1) * 128_000,
								);
							await transaction.put(entries);
							for (let index = chunks; index < (current?.chunks ?? 0); index++)
								await transaction.delete(`snapshot:${index}`);
						}
						return true;
					},
				);
				if (!written) return new Response(null, { status: 410 });
				// Storage awaits permit interleaving: never regress the in-memory broadcast either.
				if (
					!this.latest ||
					BigInt(incoming.revision) > BigInt(this.latest.revision)
				) {
					this.latest = incoming;
					for (const send of this.subscribers) send(incoming);
				}
			}
			return new Response(null, { status: 204 });
		}
		if (
			!this.latest ||
			this.latest.userId !== url.searchParams.get("userId") ||
			this.latest.sessionId !== url.searchParams.get("sessionId")
		)
			return new Response(null, { status: 404 });
		if (this.subscribers.size >= 16) return new Response(null, { status: 429 });
		const minimumRevision = url.searchParams.get("revision");
		if (
			minimumRevision &&
			(!/^[1-9]\d{0,19}$/.test(minimumRevision) ||
				BigInt(this.latest.revision) < BigInt(minimumRevision))
		)
			return new Response(null, { status: 409 });
		let stop = () => {};
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					let ended = false;
					let revision = 0n;
					const send = (value: ConversationSnapshot) => {
						if (ended || BigInt(value.revision) <= revision) return;
						if ((controller.desiredSize ?? 0) <= 0) {
							stop();
							return;
						}
						revision = BigInt(value.revision);
						controller.enqueue(encoder.encode(conversationEvent(value)));
					};
					const heartbeat = setInterval(() => {
						if (!ended && (controller.desiredSize ?? 0) > 0)
							controller.enqueue(encoder.encode(": heartbeat\n\n"));
					}, 10_000);
					// Bound authorization lifetime; EventSource reconnect rechecks the web user's ownership.
					const expiry = setTimeout(() => stop(), 60_000);
					stop = () => {
						if (ended) return;
						ended = true;
						clearInterval(heartbeat);
						clearTimeout(expiry);
						this.subscribers.delete(send);
						request.signal.removeEventListener("abort", stop);
						if (!cancelled) controller.close();
					};
					this.subscribers.add(send);
					request.signal.addEventListener("abort", stop, { once: true });
					if (request.signal.aborted) stop();
					else if (this.latest) send(this.latest);
				},
				cancel: () => {
					cancelled = true;
					stop();
				},
			},
			{ highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
		);
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store, no-transform",
			},
		});
	}
	private async controlTurn(request: Request) {
		const input = turnControlSchema.parse(await request.json());
		const action = new URL(request.url).pathname.split("/").at(-1);
		return this.state.storage.transaction(async (storage) => {
			if (this.purged) return new Response(null, { status: 410 });
			const identity = await storage.get<{ userId: string; sessionId: string }>(
				"identity",
			);
			if (
				identity &&
				(identity.userId !== input.userId ||
					identity.sessionId !== input.sessionId)
			)
				return new Response(null, { status: 403 });
			await storage.put("identity", {
				userId: input.userId,
				sessionId: input.sessionId,
			});
			const current = await storage.get<ActiveConversationTurn>("active-turn");
			const retired =
				(await storage.get<Record<string, number>>("retired-turns")) ?? {};
			for (const [id, expiry] of Object.entries(retired))
				if (expiry <= Date.now()) delete retired[id];
			const same =
				current?.turnId === input.turnId && current?.leaseId === input.leaseId;
			if (action === "acquire") {
				if (retired[input.turnId] || Object.keys(retired).length >= 256)
					return new Response(null, { status: 409 });
				if (
					current &&
					((same && (current.cancelled || current.expiresAt <= Date.now())) ||
						(!same && current.expiresAt > Date.now()))
				)
					return new Response(null, { status: 409 });
			} else if (
				!same ||
				(current?.cancelled && action !== "release" && action !== "cancel") ||
				(action === "renew" && current.expiresAt <= Date.now())
			) {
				return new Response(null, { status: 409 });
			}
			if (action === "release") {
				retired[input.turnId] = Date.now() + 70_000;
				await storage.put("retired-turns", retired);
				await storage.delete("active-turn");
				await this.schedule(null);
			} else {
				if (current && !same) retired[current.turnId] = Date.now() + 70_000;
				await storage.put("retired-turns", retired);
				const next: ActiveConversationTurn = {
					...input,
					expiresAt: Date.now() + TURN_COORDINATION_LEASE_MS,
					cancelled: action === "cancel",
				};
				await storage.put("active-turn", next);
				await this.schedule(next.expiresAt);
			}
			return new Response(null, { status: 204 });
		});
	}
	/**
	 * The chat's own turn loop resuming a step after its object restarted, under a
	 * rotated lease: the coordination lease may have lapsed meanwhile, but a
	 * cancelled turn or one replaced by a newer turn stays stopped.
	 */
	async reclaim(input: { turnId: string; leaseId: string }) {
		return this.state.storage.transaction(async (storage) => {
			if (this.purged) return false;
			const current = await storage.get<ActiveConversationTurn>("active-turn");
			// The resuming chat rotates the lease, so the turn ID alone identifies it.
			if (current) {
				const same = current.turnId === input.turnId;
				if (same ? current.cancelled : current.expiresAt > Date.now())
					return false;
			}
			const retired =
				(await storage.get<Record<string, number>>("retired-turns")) ?? {};
			delete retired[input.turnId];
			await storage.put("retired-turns", retired);
			const identity = await storage.get<{ userId: string; sessionId: string }>(
				"identity",
			);
			if (!identity) return false;
			const next: ActiveConversationTurn = {
				...identity,
				...input,
				expiresAt: Date.now() + TURN_COORDINATION_LEASE_MS,
				cancelled: false,
			};
			await storage.put("active-turn", next);
			await this.schedule(next.expiresAt);
			return true;
		});
	}
	async alarm() {
		await this.state.storage.transaction(async (storage) => {
			if (this.purged) return;
			const turn = await storage.get<ActiveConversationTurn>("active-turn");
			if (!turn) return;
			if (turn.expiresAt <= Date.now()) {
				const retired =
					(await storage.get<Record<string, number>>("retired-turns")) ?? {};
				for (const [id, expiry] of Object.entries(retired))
					if (expiry <= Date.now()) delete retired[id];
				retired[turn.turnId] = Date.now() + 70_000;
				await storage.put("retired-turns", retired);
				await storage.delete("active-turn");
			} else await this.schedule(turn.expiresAt);
		});
	}
}

export default {
	async fetch(
		request: Request,
		environment: RealtimeEnvironment,
	): Promise<Response> {
		return routeRealtimeRequest(
			request,
			environment.DELIVERY_SECRET,
			async (scope, forwarded) => {
				const room = environment.CONVERSATIONS.get(
					environment.CONVERSATIONS.idFromName(
						JSON.stringify([scope.userId, scope.sessionId]),
					),
				);
				return (await room.fetch(forwarded as never)) as unknown as Response;
			},
		);
	},
};

/** Shared authenticated routing permits realtime and model execution to use the same chat DO. */
export async function routeRealtimeRequest(
	request: Request,
	secret: string,
	forward: (
		scope: { userId: string; sessionId: string },
		request: Request,
	) => Promise<Response>,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		if (
			!(
				(request.method === "POST" &&
					(url.pathname === "/snapshot" ||
						url.pathname === "/purge" ||
						/^\/turn\/(acquire|renew|release|cancel)$/.test(url.pathname))) ||
				(request.method === "GET" && url.pathname === "/stream")
			)
		)
			return new Response(null, { status: 404 });
		const body = await boundedBody(request);
		if (!(await verifyDeliveryRequest(secret, request, body)))
			return new Response(null, { status: 401 });
		const scope =
			request.method === "POST"
				? (url.pathname === "/snapshot"
						? conversationSnapshotSchema
						: url.pathname === "/purge"
							? conversationPurgeSchema
							: turnControlSchema
					).parse(JSON.parse(body))
				: {
						userId: url.searchParams.get("userId"),
						sessionId: url.searchParams.get("sessionId"),
					};
		if (
			!scope.userId ||
			!scope.sessionId ||
			!/^[a-f0-9-]{36}$/.test(scope.sessionId)
		)
			return new Response(null, { status: 400 });
		// Worker types and the web app use separate DOM type declarations for Request/Response.
		const forwarded = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			...(request.method === "POST" ? { body } : {}),
			signal: request.signal,
		});
		return await forward(
			{ userId: scope.userId, sessionId: scope.sessionId },
			forwarded,
		);
	} catch {
		return new Response(null, { status: 400 });
	}
}
