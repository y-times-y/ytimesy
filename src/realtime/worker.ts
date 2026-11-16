import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { readBoundedRequestBody } from "../domain/bounded-request-body";
import {
	applyConversationDelta,
	type ConversationDelta,
	type ConversationSnapshot,
	type ConversationUpdate,
	conversationDeltaEvent,
	conversationDeltaSchema,
	conversationEvent,
	conversationSnapshotSchema,
	isConversationDelta,
	MAX_DELIVERY_BYTES,
} from "../domain/conversation-delivery";
import {
	type ActiveConversationTurn,
	conversationPurgeSchema,
	TURN_COORDINATION_LEASE_MS,
	turnControlSchema,
} from "../domain/conversation-turn-control";
import { verifyDeliveryRequest } from "../domain/delivery-auth";
import {
	LIVE_SOCKET_CLOSE,
	liveProgressMessage,
} from "../domain/live-progress-socket";
import {
	pingAutoResponse,
	type ServerSocket,
	socketPair,
	upgradeResponse,
} from "./socket-upgrade";

type RealtimeEnvironment = {
	CONVERSATIONS: DurableObjectNamespace;
	DELIVERY_SECRET: string;
};
const encoder = new TextEncoder();
type SnapshotHead = { revision: string; chunks: number };
/**
 * What one broadcast sends: the full snapshot's frame (built once, only if a
 * viewer needs it), and the delta's frame for viewers that merge deltas and
 * hold the snapshot it applies to (`baseRevision`).
 */
type Frames = {
	full: () => Uint8Array;
	delta?: {
		baseRevision: string;
		frame: Uint8Array;
		update: ConversationDelta;
	};
};

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
	// Hibernatable WebSockets (absent from the tests' storage-only fakes).
	acceptWebSocket?(socket: ServerSocket, tags?: string[]): void;
	getWebSockets?(tag?: string): ServerSocket[];
	setWebSocketAutoResponse?(pair?: unknown): void;
}

/** How the room makes viewer sockets; tests replace the Workers runtime's. */
export type ViewerSockets = {
	pair: typeof socketPair;
	upgrade: typeof upgradeResponse;
	autoResponse: typeof pingAutoResponse;
};
const workersViewerSockets: ViewerSockets = {
	pair: socketPair,
	upgrade: upgradeResponse,
	autoResponse: pingAutoResponse,
};

/** The tag of a live viewer's socket, so other sockets are never pushed to. */
const VIEWER_TAG = "viewer";
/** Most viewers (sockets and old event streams together) one chat serves. */
const MAX_VIEWERS = 16;
/**
 * How long a socket's authorization holds. The first push after it closes
 * the socket (no timer), and the browser's reconnect checks the user again,
 * as the old event stream's 60-second bound did.
 */
const VIEWER_AUTHORIZATION_MS = 60_000;
type ViewerAttachment = {
	sessionId: string;
	openedAt: number;
	authorizedUntil: number;
	revision: string;
};
function viewerAttachment(socket: ServerSocket): ViewerAttachment | null {
	try {
		const value = socket.deserializeAttachment() as ViewerAttachment | null;
		return value && typeof value.openedAt === "number" ? value : null;
	} catch {
		return null;
	}
}
/** One line per socket open and close, to measure how long viewers stay. */
function logViewer(event: string, detail: Record<string, unknown>) {
	console.info(`live-progress ${JSON.stringify({ event, ...detail })}`);
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
		(snapshot: ConversationSnapshot, frames?: Frames) => void
	>();
	/** Publications run one at a time: a delta merges into the snapshot the last one left. */
	private publications: Promise<unknown> = Promise.resolve();
	/** The host object's listener for a newer snapshot (the chat DO tells its Claude Code runner). */
	private adopted: (() => void) | null = null;
	/**
	 * `schedule` lets a host object that also uses the alarm (the chat DO's turn
	 * loop) multiplex it; by default the room owns the alarm.
	 */
	private readonly schedule: (at: number | null) => Promise<void>;
	constructor(
		private readonly state: ConversationRoomState,
		// The realtime Worker instantiates this class as a Durable Object, passing its env here.
		schedule?: unknown,
		private readonly sockets: ViewerSockets = workersViewerSockets,
	) {
		// Keep-alive pings are answered by the runtime while the object sleeps.
		state.setWebSocketAutoResponse?.(sockets.autoResponse());
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
		for (const socket of this.viewers()) {
			try {
				socket.close(LIVE_SOCKET_CLOSE.gone, "deleted");
			} catch {}
		}
		await this.state.storage.deleteAll?.();
		await this.state.storage.put(PURGED_KEY, true);
	}
	get isPurged() {
		return this.purged;
	}
	/** Called after each newer snapshot is kept; a throwing listener is ignored. */
	onAdopted(listener: () => void) {
		this.adopted = listener;
	}
	/** The latest snapshot's timeline items (queued messages last), none without one. */
	latestItems(): readonly unknown[] {
		return this.latest?.progress.items ?? [];
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
		if (url.pathname === "/live") return this.admitViewer(request, url);
		if (url.pathname.startsWith("/turn/")) return this.controlTurn(request);
		if (request.method === "POST" && url.pathname === "/delta")
			return this.publish(conversationDeltaSchema.parse(await request.json()));
		if (request.method === "POST") {
			const incoming = conversationSnapshotSchema.parse(await request.json());
			if (url.pathname !== "/stream") return this.publish(incoming);
			// A subscription that brings the chat's snapshot from Postgres: a
			// room without it (a new chat, a restarted object) is seeded in the
			// same round trip instead of a miss, a publish and a resubscribe.
			if (
				incoming.userId !== url.searchParams.get("userId") ||
				incoming.sessionId !== url.searchParams.get("sessionId")
			)
				return new Response(null, { status: 400 });
			const refused = await this.serialized(() => this.adopt(incoming));
			if (refused) return refused;
		}
		const refused = this.refuseViewer(url);
		if (refused) return refused;
		const deltas = url.searchParams.get("deltas") === "1";
		let stop = () => {};
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					let ended = false;
					let revision = 0n;
					const send = (value: ConversationSnapshot, frames?: Frames) => {
						if (ended || BigInt(value.revision) <= revision) return;
						if ((controller.desiredSize ?? 0) <= 0) {
							stop();
							return;
						}
						const delta =
							deltas &&
							frames?.delta &&
							BigInt(frames.delta.baseRevision) === revision
								? frames.delta.frame
								: undefined;
						revision = BigInt(value.revision);
						controller.enqueue(
							delta ??
								frames?.full() ??
								encoder.encode(conversationEvent(value)),
						);
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
	/**
	 * Why this chat's snapshot cannot be shown to a new viewer: none here or
	 * another chat's (404, the caller seeds it from Postgres), too many viewers
	 * (429), or older than the caller's copy (409, seeded again).
	 */
	private refuseViewer(url: URL): Response | null {
		if (
			!this.latest ||
			this.latest.userId !== url.searchParams.get("userId") ||
			this.latest.sessionId !== url.searchParams.get("sessionId")
		)
			return new Response(null, { status: 404 });
		if (this.subscribers.size + this.viewers().length >= MAX_VIEWERS)
			return new Response(null, { status: 429 });
		const minimumRevision = url.searchParams.get("revision");
		if (
			minimumRevision &&
			(!/^[1-9]\d{0,19}$/.test(minimumRevision) ||
				BigInt(this.latest.revision) < BigInt(minimumRevision))
		)
			return new Response(null, { status: 409 });
		return null;
	}
	/** Someone has the chat open live: a socket or an older event stream. */
	watched(): boolean {
		return this.subscribers.size + this.viewers().length > 0;
	}
	private viewers(): ServerSocket[] {
		return this.state.getWebSockets?.(VIEWER_TAG) ?? [];
	}
	/**
	 * A live viewer's hibernatable socket: it gets the current snapshot now and
	 * every newer one as it is published; between them the object sleeps.
	 */
	private admitViewer(request: Request, url: URL): Response {
		if (!this.state.acceptWebSocket) return new Response(null, { status: 404 });
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
			return new Response(null, { status: 426 });
		const refused = this.refuseViewer(url);
		if (refused || !this.latest)
			return refused ?? new Response(null, { status: 404 });
		const { client, server } = this.sockets.pair();
		this.state.acceptWebSocket(server, [VIEWER_TAG]);
		const openedAt = Date.now();
		const viewer: ViewerAttachment = {
			sessionId: this.latest.sessionId,
			openedAt,
			authorizedUntil: openedAt + VIEWER_AUTHORIZATION_MS,
			revision: this.latest.revision,
		};
		server.serializeAttachment(viewer);
		server.send(liveProgressMessage(this.latest));
		logViewer("open", {
			sessionId: viewer.sessionId,
			viewers: this.viewers().length,
		});
		return this.sockets.upgrade(client);
	}
	/** Only a ping is expected, and the runtime answers it; the rest is ignored. */
	webSocketMessage(_socket: ServerSocket, _message: unknown) {}
	webSocketClose(
		socket: ServerSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	) {
		this.endViewer(socket, "close", { code, reason, wasClean });
		try {
			socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {}
	}
	webSocketError(socket: ServerSocket, _error: unknown) {
		this.endViewer(socket, "error", {});
	}
	private endViewer(
		socket: ServerSocket,
		event: string,
		detail: Record<string, unknown>,
	) {
		const viewer = viewerAttachment(socket);
		if (!viewer) return;
		// Logged once: an error and the close after it are one ending.
		try {
			socket.serializeAttachment(null);
		} catch {}
		logViewer(event, {
			sessionId: viewer.sessionId,
			seconds: Math.round((Date.now() - viewer.openedAt) / 1000),
			viewers: this.viewers().filter((other) => other !== socket).length,
			...detail,
		});
	}
	/**
	 * Pushes one frame to every live viewer; a viewer whose authorization
	 * window ended is closed instead and reconnects for a full snapshot.
	 */
	private pushToViewers(
		viewers: ServerSocket[],
		snapshot: ConversationSnapshot,
		delta?: { baseRevision: string; update: ConversationDelta },
	) {
		let full: string | undefined;
		const now = Date.now();
		for (const socket of viewers) {
			const viewer = viewerAttachment(socket);
			try {
				if (viewer && viewer.authorizedUntil > now) {
					if (!delta || viewer.revision !== delta.baseRevision)
						full ??= liveProgressMessage(snapshot);
					const message =
						delta && viewer.revision === delta.baseRevision
							? JSON.stringify({
									revision: snapshot.revision,
									delta: delta.update,
								})
							: (full ?? liveProgressMessage(snapshot));
					socket.send(message);
					socket.serializeAttachment({
						...viewer,
						revision: snapshot.revision,
					});
				} else if (viewer)
					socket.close(LIVE_SOCKET_CLOSE.reauthorize, "reauthorize");
			} catch {
				// A socket closing meanwhile: its close handler ends it.
			}
		}
	}
	/**
	 * Sends a frame that is not part of the chat's copy (a Claude Code
	 * preview, claude-feed-preview.ts) to the live sockets as is: no revision,
	 * nothing stored. True when a socket took it and no event-stream viewer
	 * (which cannot take one) is open.
	 */
	preview(frame: string): boolean {
		const now = Date.now();
		let sent = 0;
		for (const socket of this.viewers()) {
			const viewer = viewerAttachment(socket);
			if (!viewer || viewer.authorizedUntil <= now) continue;
			try {
				socket.send(frame);
				sent++;
			} catch {
				// A socket closing meanwhile: its close handler ends it.
			}
		}
		return sent > 0 && this.subscribers.size === 0;
	}
	/** Trusted in-process publication avoids a JSON Request/parse round trip. */
	async publish(incoming: ConversationUpdate): Promise<Response> {
		if (this.purged) return new Response(null, { status: 410 });
		const refused = await this.serialized(() =>
			isConversationDelta(incoming)
				? this.adoptDelta(incoming)
				: this.adopt(incoming),
		);
		return refused ?? new Response(null, { status: 204 });
	}
	private serialized<T>(run: () => Promise<T>): Promise<T> {
		const next = this.publications.then(run, run);
		this.publications = next.catch(() => {});
		return next;
	}
	/** Merges a delta into the latest snapshot; 409 when this copy is not the one it applies to. */
	private async adoptDelta(delta: ConversationDelta): Promise<Response | null> {
		const latest = this.latest;
		if (!latest) return new Response(null, { status: 409 });
		if (latest.userId !== delta.userId || latest.sessionId !== delta.sessionId)
			return new Response(null, { status: 403 });
		// Already past it (a full snapshot arrived meanwhile): nothing to do.
		if (BigInt(delta.revision) <= BigInt(latest.revision)) return null;
		const merged = applyConversationDelta(latest, delta);
		if (!merged) return new Response(null, { status: 409 });
		return this.adopt(
			{
				userId: latest.userId,
				sessionId: latest.sessionId,
				revision: delta.revision,
				...merged,
			},
			{
				baseRevision: latest.revision,
				frame: encoder.encode(conversationDeltaEvent(delta)),
				update: delta,
			},
		);
	}
	/** Keeps a newer snapshot and broadcasts it; a refusal's response otherwise. */
	private async adopt(
		incoming: ConversationSnapshot,
		delta?: Frames["delta"],
	): Promise<Response | null> {
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
				// All viewers receive the same immutable frame, not one large JSON
				// serialization and byte buffer per viewer; the full one only if a
				// viewer cannot take the delta.
				if (this.subscribers.size) {
					let full: Uint8Array | undefined;
					const frames: Frames = {
						full: () => {
							full ??= encoder.encode(conversationEvent(incoming));
							return full;
						},
						delta,
					};
					for (const send of this.subscribers) send(incoming, frames);
				}
				// No viewer: no frame is built and nothing is sent.
				const viewers = this.viewers();
				if (viewers.length) this.pushToViewers(viewers, incoming, delta);
				try {
					this.adopted?.();
				} catch {}
			}
		}
		return null;
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

/** Turn coordination paths of a chat's room; other /turn/* paths are not the room's. */
const ROOM_TURN_PATH = /^\/turn\/(acquire|renew|release|cancel)$/;

/**
 * Whether a path is the chat room's (snapshots, the stream, purge and turn
 * coordination), by exact name: the executor routes everything else itself
 * (its own POST /turn/start included).
 */
export function isRealtimeRoute(pathname: string) {
	return (
		pathname === "/snapshot" ||
		pathname === "/delta" ||
		pathname === "/stream" ||
		pathname === "/live" ||
		pathname === "/purge" ||
		ROOM_TURN_PATH.test(pathname)
	);
}

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
						url.pathname === "/delta" ||
						url.pathname === "/stream" ||
						url.pathname === "/purge" ||
						ROOM_TURN_PATH.test(url.pathname))) ||
				(request.method === "GET" &&
					(url.pathname === "/stream" || url.pathname === "/live"))
			)
		)
			return new Response(null, { status: 404 });
		const body = await boundedBody(request);
		if (!(await verifyDeliveryRequest(secret, request, body)))
			return new Response(null, { status: 401 });
		const scope =
			request.method === "POST"
				? (url.pathname === "/snapshot" || url.pathname === "/stream"
						? conversationSnapshotSchema
						: url.pathname === "/delta"
							? conversationDeltaSchema
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
		// A WebSocket upgrade carries no signal: one would stay bound to the
		// socket after the handshake.
		const forwarded = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			...(request.method === "POST" ? { body } : {}),
			...(url.pathname === "/live" ? {} : { signal: request.signal }),
		});
		return await forward(
			{ userId: scope.userId, sessionId: scope.sessionId },
			forwarded,
		);
	} catch {
		return new Response(null, { status: 400 });
	}
}
