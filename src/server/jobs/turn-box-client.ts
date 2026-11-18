import type { ModelMessage } from "ai";
import { ApiTurnCancelled } from "#/domain/api-turn-failure";
import { LatestCoalescer } from "#/domain/latest-coalescer";
import type { TurnFailoverColumn } from "#/domain/model-failover";
import type { SessionItem } from "#/domain/session-item";
import {
	type BoxPortArgs,
	type BoxPortOp,
	claimResponse,
	edgeSocketMessage,
	historyResponse,
	portResponse,
	renewResponse,
	TURN_BOX_PATHS,
	TURN_BOX_PROGRESS_EVERY_MS,
	type TurnBoxEdgeSocketMessage,
	TurnBoxPortForbidden,
	type TurnBoxTurnIdentity,
} from "#/domain/turn-box-protocol";
import {
	SUBSCRIPTION_ERROR_HEADER,
	subscriptionErrorOf,
} from "#/domain/turn-box-subscription";
import { TurnPortUnavailable } from "./turn-ports";

/**
 * A turn runner box's client of the edge's thin-client API
 * (docs/turn-runner-boxes.md). It holds only the edge's URL and the box's
 * identity token (turn-box-grant.ts); everything else comes from the edge
 * per turn as a grant. Its methods have the shapes of the api-turns.ts
 * writers the model loop calls (`adapters()`), so the loop needs no database
 * URL, provider key, vault key or workspace credential of its own.
 * Plain fetch and an optional socket: no OS-specific code.
 */
export class TurnBoxLeaseLost extends Error {
	constructor() {
		super("API turn lease was lost.");
		this.name = "TurnBoxLeaseLost";
	}
}

/**
 * A `fetch` for the model SDK that sends every request with the turn's
 * CURRENT grant (renewals replace it, so the key cannot be fixed when the SDK
 * is built) and refuses any URL outside the edge's model proxy, so a grant
 * can never be sent to another host. Authentication slots of all three
 * providers (authorization, x-api-key, x-goog-api-key) carry the grant.
 */
export function grantRotatingFetch(options: {
	/** The turn's current grant, read per request. */
	readonly grant: () => string;
	/** The proxy's base URL (`<edge>/box/v1/model`). */
	readonly baseUrl: string;
	readonly fetch?: typeof fetch;
}): typeof fetch {
	const base = new URL(options.baseUrl);
	const prefix = `${base.pathname.replace(/\/+$/, "")}/`;
	return ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
		);
		if (url.origin !== base.origin || !url.pathname.startsWith(prefix))
			throw new Error("A turn box only sends model requests to its edge.");
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		const grant = options.grant();
		headers.set("authorization", `Bearer ${grant}`);
		headers.set("x-api-key", grant);
		headers.set("x-goog-api-key", grant);
		// Redirects would carry the grant elsewhere: "manual" never follows one (a 3xx arrives as a non-ok response the SDK rejects); "error" is not supported on Workers.
		return (options.fetch ?? fetch)(input, {
			...init,
			headers,
			redirect: "manual",
		});
	}) as typeof fetch;
}

/**
 * A subscription route the edge could not serve answers with a typed code
 * (turn-box-subscription.ts); this throws the same error the Durable Object's
 * own transport would, so the turn's failure wording and failover reason do
 * not depend on where it ran. Any other response passes through unread.
 */
export function subscriptionErrorFetch(request: typeof fetch): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await request(input, init);
		const code = response.headers.get(SUBSCRIPTION_ERROR_HEADER);
		if (!code) return response;
		const body = await response.json().catch(() => null);
		const error = subscriptionErrorOf(code, body);
		if (error) throw error;
		return new Response(JSON.stringify(body), {
			status: response.status,
			headers: response.headers,
		});
	}) as typeof fetch;
}

export type BoxSocket = {
	send(data: string): void;
	close(): void;
	onMessage(handler: (data: string) => void): void;
	onClose(handler: () => void): void;
};
export type BoxSocketFactory = (
	url: string,
	grant: string,
) => Promise<BoxSocket>;

/** The runtime's WebSocket (Node 22+, Bun, Deno), with the grant as the bearer. Not run against a real edge yet. */
export const runtimeBoxSocket: BoxSocketFactory = (url, grant) =>
	new Promise((resolve, reject) => {
		const socket = new (
			WebSocket as unknown as new (
				url: string,
				options: unknown,
			) => WebSocket
		)(url.replace(/^http/, "ws"), {
			headers: { authorization: `Bearer ${grant}` },
		});
		const messages: ((data: string) => void)[] = [];
		const closes: (() => void)[] = [];
		socket.addEventListener("open", () =>
			resolve({
				send: (data) => socket.send(data),
				close: () => socket.close(),
				onMessage: (handler) => messages.push(handler),
				onClose: (handler) => closes.push(handler),
			}),
		);
		socket.addEventListener("message", (event) => {
			if (typeof event.data === "string")
				for (const handler of messages) handler(event.data);
		});
		socket.addEventListener("close", () => {
			for (const handler of closes) handler();
		});
		socket.addEventListener("error", () => reject(new Error("socket failed")));
	});

type ClientOptions = {
	/** The edge Worker's origin, e.g. https://ytimesy.example. */
	readonly edgeUrl: string;
	/** The box's identity token (`ytbi1...`): its only credential. */
	readonly identity: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly randomNonce?: () => string;
	readonly socket?: BoxSocketFactory;
};

function nonce() {
	return Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
}

export class TurnBoxEdgeClient {
	constructor(private readonly options: ClientOptions) {}

	private call(path: string, token: string, body: unknown, headers = {}) {
		return (this.options.fetch ?? fetch)(
			new URL(path, this.options.edgeUrl).href,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					...headers,
				},
				body: JSON.stringify(body),
			},
		);
	}

	/** Heartbeat of the box itself (capacity for routing); false once the box is revoked. */
	async register(input: {
		capacity: number;
		running: number;
		version?: string;
	}) {
		const response = await this.call(
			TURN_BOX_PATHS.register,
			this.options.identity,
			input,
		);
		await response.body?.cancel().catch(() => undefined);
		if (response.status === 403) return false;
		if (!response.ok) throw new Error("Box registration failed.");
		return true;
	}

	/** Claims one queued turn; null when there is none. */
	async claim(perUserLimit?: number): Promise<TurnBoxTurnSession | null> {
		const response = await this.call(
			TURN_BOX_PATHS.claim,
			this.options.identity,
			perUserLimit ? { perUserLimit } : {},
			{
				"x-ytimesy-nonce": (this.options.randomNonce ?? nonce)(),
				"x-ytimesy-ts": String((this.options.now ?? Date.now)()),
			},
		);
		if (response.status === 204) return null;
		if (!response.ok)
			throw new Error(`Turn claim failed (${response.status}).`);
		const claimed = claimResponse.parse(await response.json());
		return new TurnBoxTurnSession(this.options, claimed.turn, claimed.grant);
	}
}

export class TurnBoxTurnSession {
	private grantToken: string;
	/** Set when the edge committed changes it must still push at finalize. */
	publishAfterFinalize = false;
	/** When the edge last confirmed the lease (a renewal, or a checkpoint's piggybacked one). */
	private renewedAt = Number.NEGATIVE_INFINITY;
	/** The state this box last checkpointed: the turn's own history, kept so a step boundary needs no read. */
	private saved: { messages: ModelMessage[]; items: SessionItem[] } | null =
		null;
	private socket: BoxSocket | null = null;
	private seq = 0;
	private cancelled = false;
	private lost = false;
	private waiting = new Map<number, (ok: boolean) => void>();
	private historyCache: {
		version: string;
		messages: ModelMessage[];
		items: SessionItem[];
	} | null = null;
	private readonly progressSender: LatestCoalescer<readonly SessionItem[]>;
	/** Called once when Stop reaches the box (socket push, or a heartbeat/write refusal). */
	onCancel?: () => void;

	constructor(
		private readonly options: ClientOptions,
		readonly turn: TurnBoxTurnIdentity,
		grant: string,
	) {
		this.grantToken = grant;
		this.progressSender = new LatestCoalescer(
			(items) => this.sendProgress(items),
			{
				everyMs: TURN_BOX_PROGRESS_EVERY_MS,
				now: options.now,
				onError: () => undefined,
			},
		);
	}

	get grant() {
		return this.grantToken;
	}
	/**
	 * The model SDK's settings: the edge proxy as base URL, a placeholder
	 * "key" (the SDK needs one; the box holds no provider key) and a fetch
	 * that injects the current grant. API-key connections only.
	 */
	modelSdkSettings() {
		const baseUrl = new URL(TURN_BOX_PATHS.model, this.options.edgeUrl).href;
		return {
			baseUrl,
			apiKey: "turn-box-grant",
			fetch: subscriptionErrorFetch(
				grantRotatingFetch({
					grant: () => this.grantToken,
					baseUrl,
					fetch: this.options.fetch,
				}),
			),
		};
	}
	/** The proxy base URL and API key to give the model SDK (API-key connections only). */
	modelEndpoint() {
		return {
			baseUrl: new URL(TURN_BOX_PATHS.model, this.options.edgeUrl).href,
			apiKey: () => this.grantToken,
		};
	}

	private async post(path: string, body: unknown) {
		const response = await (this.options.fetch ?? fetch)(
			new URL(path, this.options.edgeUrl).href,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${this.grantToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			},
		);
		if (response.status === 409) {
			const refused = (await response.json().catch(() => ({}))) as {
				reason?: string;
			};
			if (refused.reason === "cancelled") {
				this.markCancelled();
				throw new ApiTurnCancelled();
			}
			this.lost = true;
			throw new TurnBoxLeaseLost();
		}
		if (response.status === 401) {
			this.lost = true;
			throw new TurnBoxLeaseLost();
		}
		return response;
	}

	private markCancelled() {
		if (this.cancelled) return;
		this.cancelled = true;
		this.onCancel?.();
	}

	/** Opens the turn's ONE socket (progress, renewals, Stop); falls back to HTTP when it cannot. */
	async openSocket() {
		const factory = this.options.socket ?? runtimeBoxSocket;
		try {
			const socket = await factory(
				new URL(TURN_BOX_PATHS.socket, this.options.edgeUrl).href,
				this.grantToken,
			);
			socket.onMessage((data) => this.socketMessage(data));
			socket.onClose(() => {
				if (this.socket === socket) this.socket = null;
				for (const done of this.waiting.values()) done(false);
				this.waiting.clear();
			});
			this.socket = socket;
			return true;
		} catch {
			return false;
		}
	}

	private socketMessage(data: string) {
		let message: TurnBoxEdgeSocketMessage;
		try {
			message = edgeSocketMessage.parse(JSON.parse(data));
		} catch {
			return;
		}
		if (message.t === "cancel") this.markCancelled();
		else if (message.t === "lease-lost") this.lost = true;
		else this.waiting.get(message.seq)?.(message.ok);
		if (message.t !== "ack")
			for (const done of this.waiting.values()) done(false);
	}

	/**
	 * One turn port call (turn-box-protocol.ts `boxPortArgs`) over HTTP. The
	 * edge answers from the grant's own turn: a stale lease is
	 * TurnBoxLeaseLost (409), a cancelled turn ApiTurnCancelled, an op the
	 * edge does not serve TurnPortUnavailable (501), an argument outside the
	 * turn's chat or project TurnBoxPortForbidden (403).
	 */
	async port<Op extends BoxPortOp>(
		op: Op,
		args: BoxPortArgs<Op>,
	): Promise<unknown> {
		const response = await this.post(TURN_BOX_PATHS.port, { op, args });
		if (response.status === 501) {
			await response.body?.cancel().catch(() => undefined);
			throw new TurnPortUnavailable(op);
		}
		if (response.status === 403) {
			await response.body?.cancel().catch(() => undefined);
			throw new TurnBoxPortForbidden(op);
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`Turn port ${op} failed (${response.status}).`);
		}
		return portResponse.parse(await response.json()).result;
	}

	/** Lease renewal: over the socket when open, else HTTP. */
	async renew(): Promise<"renewed" | "cancel" | "lost"> {
		if (this.cancelled) return "cancel";
		if (this.socket) {
			const seq = ++this.seq;
			const acked = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 10_000);
				this.waiting.set(seq, (ok) => {
					clearTimeout(timer);
					this.waiting.delete(seq);
					resolve(ok);
				});
				this.socket?.send(JSON.stringify({ t: "renew", seq }));
			});
			if (acked) {
				this.renewedAt = this.clock();
				return "renewed";
			}
			if (this.cancelled) return "cancel";
			if (this.lost) return "lost";
			// No answer: the HTTP path decides.
		}
		const response = renewResponse.parse(
			await (await this.post(TURN_BOX_PATHS.renew, {})).json(),
		);
		if (response.grant) this.grantToken = response.grant;
		if (response.renewed) {
			this.renewedAt = this.clock();
			return "renewed";
		}
		if (response.cancelRequested) this.markCancelled();
		else this.lost = true;
		return response.cancelRequested ? "cancel" : "lost";
	}

	private async sendProgress(items: readonly SessionItem[]) {
		if (this.socket) {
			this.socket.send(
				JSON.stringify({ t: "progress", seq: ++this.seq, items }),
			);
			return;
		}
		await this.post(TURN_BOX_PATHS.progress, { items });
	}

	/** Coalesced: at most one message per TURN_BOX_PROGRESS_EVERY_MS, the newest items. */
	publishProgress(items: readonly SessionItem[]) {
		this.progressSender.push(items);
	}

	async checkpoint(
		messages: readonly ModelMessage[],
		items: readonly SessionItem[],
		failover?: TurnFailoverColumn,
	) {
		// The checkpoint carries the items: nothing older may land after it.
		this.progressSender.discard();
		const response = await this.post(TURN_BOX_PATHS.checkpoint, {
			messages,
			items,
			failover,
		});
		const body = (await response.json().catch(() => ({}))) as {
			renewed?: boolean;
		};
		if (body.renewed) this.renewedAt = this.clock();
		this.historyCache = null;
		this.saved = {
			messages: [...messages],
			items: [...items],
		};
	}

	private clock() {
		return (this.options.now ?? Date.now)();
	}

	/** Whether the edge confirmed the lease within `ms` (a renewal or a checkpoint). */
	renewedWithin(ms: number) {
		return this.clock() - this.renewedAt < ms;
	}

	/** What this box last checkpointed (null before the first): the turn's history without a request. */
	savedHistory() {
		return this.saved;
	}

	async finalize(
		state: "completed" | "failed" | "cancelled",
		items: readonly SessionItem[],
		messages?: readonly ModelMessage[],
	) {
		this.progressSender.close();
		const response = await this.post(TURN_BOX_PATHS.finalize, {
			state,
			items,
			messages,
			...(this.publishAfterFinalize ? { publish: true } : {}),
		});
		const body = (await response.json()) as { state?: typeof state };
		this.socket?.close();
		return body.state ?? null;
	}

	/** The turn's messages and items; the edge answers "not modified" for the version held. */
	async history() {
		const response = await this.post(TURN_BOX_PATHS.history, {
			version: this.historyCache?.version,
		});
		const body = historyResponse.parse(await response.json());
		if (body.notModified && this.historyCache) return this.historyCache;
		if (body.notModified) throw new Error("History cache lost.");
		this.historyCache = {
			version: body.version,
			messages: body.messages,
			items: body.items,
		};
		return this.historyCache;
	}

	async reserve(tokens: number) {
		const response = await this.post(TURN_BOX_PATHS.reserve, { tokens });
		const body = (await response.json()) as { ok: boolean; message?: string };
		if (!body.ok) throw new Error(body.message ?? "Token reservation refused.");
	}

	async cancelRequested() {
		if (this.cancelled) return true;
		const body = (await (
			await this.post(TURN_BOX_PATHS.cancel, {})
		).json()) as {
			cancelRequested: boolean;
		};
		if (body.cancelRequested) this.markCancelled();
		return body.cancelRequested;
	}

	/**
	 * The same-shaped functions the model loop calls in api-turns.ts and
	 * api-usage-budget.ts, bound to this turn (the `turn` argument is ignored:
	 * the grant names the turn).
	 */
	adapters() {
		return {
			renewApiTurn: async () => {
				const outcome = await this.renew();
				if (outcome === "lost") throw new TurnBoxLeaseLost();
				return outcome === "renewed";
			},
			checkpointApiTurn: (
				_turn: unknown,
				messages: ModelMessage[],
				items: readonly SessionItem[],
				failover?: TurnFailoverColumn,
			) => this.checkpoint(messages, items, failover),
			publishApiTurnProgress: async (
				_turn: unknown,
				items: readonly SessionItem[],
			) => {
				this.publishProgress(items);
				return 0;
			},
			finalizeApiTurn: (
				_turn: unknown,
				state: "completed" | "failed" | "cancelled",
				items: readonly SessionItem[],
				messages?: readonly ModelMessage[],
			) => this.finalize(state, items, messages),
			apiTurnCancelRequested: () => this.cancelRequested(),
			// The edge's model proxy reserves each request's tokens from its
			// size (turn-box-model-proxy.ts), so the loop's own reservation
			// would count a step twice.
			reserveApiTokens: async (
				_userId: string,
				_sessionId: string,
				_amount: number,
			) => undefined,
		};
	}
}
