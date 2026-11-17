import type { ModelMessage } from "ai";
import { z } from "zod";
import { type ServerAnalyticsEvent, serverAnalyticsEvents } from "./analytics";
import type { TurnFailoverColumn } from "./model-failover";
import type { SessionItem } from "./session-item";

/**
 * The typed contract between a turn runner box and the edge's thin-client
 * API (docs/turn-runner-boxes.md), shared by both sides. Every path below is
 * authenticated by a per-turn grant (turn-box-grant.ts) except `claim` and
 * `register`, which present the box's identity.
 */
export const TURN_BOX_API_PREFIX = "/box/v1";
export const TURN_BOX_PATHS = {
	register: `${TURN_BOX_API_PREFIX}/register`,
	claim: `${TURN_BOX_API_PREFIX}/claim`,
	renew: `${TURN_BOX_API_PREFIX}/renew`,
	checkpoint: `${TURN_BOX_API_PREFIX}/checkpoint`,
	progress: `${TURN_BOX_API_PREFIX}/progress`,
	finalize: `${TURN_BOX_API_PREFIX}/finalize`,
	history: `${TURN_BOX_API_PREFIX}/history`,
	reserve: `${TURN_BOX_API_PREFIX}/reserve`,
	cancel: `${TURN_BOX_API_PREFIX}/cancel`,
	/** One lease-checked call of a turn "port" (see `boxPortArgs`). */
	port: `${TURN_BOX_API_PREFIX}/port`,
	socket: `${TURN_BOX_API_PREFIX}/socket`,
	/** `${model}/<provider path>`: the model proxy (API-key connections only). */
	model: `${TURN_BOX_API_PREFIX}/model`,
} as const;

/** Largest JSON body an endpoint accepts (history is the bulk of it). */
export const TURN_BOX_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Largest history the edge returns; a bigger turn must be compacted first. */
export const TURN_BOX_MAX_HISTORY_BYTES = 8 * 1024 * 1024;
/** Progress is sent at most this often (a WebSocket message bills 1/20 request). */
export const TURN_BOX_PROGRESS_EVERY_MS = 500;
/** The lease heartbeat rides the socket (or HTTP) this often; the lease lasts 45 s. */
export const TURN_BOX_RENEW_EVERY_MS = 15_000;

// Messages and items are validated by the server's own writers; here only
// their shape (arrays of objects) and size are fixed.
const records = z.array(z.record(z.string(), z.unknown())).max(100_000);
const messages = records as unknown as z.ZodType<ModelMessage[]>;
const items = records as unknown as z.ZodType<SessionItem[]>;

export const turnIdentity = z.object({
	id: z.uuid(),
	session_id: z.uuid(),
	user_id: z.string().min(1).max(128),
	connection_id: z.string().nullable(),
	connection_revision: z.string(),
	model_id: z.string(),
	lease_id: z.uuid(),
	settings: z.unknown().optional(),
	failover: z.unknown().optional(),
	run_attempts: z.number().int().nonnegative().default(0),
});
export type TurnBoxTurnIdentity = z.infer<typeof turnIdentity>;

export const registerRequest = z.object({
	capacity: z.number().int().min(1).max(64),
	running: z.number().int().min(0).max(64),
	version: z.string().max(128).optional(),
});
export const claimRequest = z.object({
	perUserLimit: z.number().int().min(1).max(64).optional(),
});
export const claimResponse = z.object({
	turn: turnIdentity,
	grant: z.string(),
	grantExpiresAt: z.number(),
});
export type TurnBoxClaimResponse = z.infer<typeof claimResponse>;

export const renewResponse = z.object({
	/** False: the lease is gone, cancelled or stale; the box must stop writing. */
	renewed: z.boolean(),
	cancelRequested: z.boolean().default(false),
	/** The chat's peer inbox holds something a step should see. */
	inbox: z.boolean().default(false),
	/** A replacement grant when the one presented is past half its life. */
	grant: z.string().optional(),
	grantExpiresAt: z.number().optional(),
});
export type TurnBoxRenewResponse = z.infer<typeof renewResponse>;

export const checkpointRequest = z.object({
	messages,
	items,
	failover: z.custom<TurnFailoverColumn>().optional(),
});
export const progressRequest = z.object({ items });
export const finalizeRequest = z.object({
	state: z.enum(["completed", "failed", "cancelled"]),
	items,
	messages: messages.optional(),
	/**
	 * The box's turn committed changes the edge still has to push (a draft
	 * pull request): the edge does it after the turn is settled, with its own
	 * GitHub and Freestyle credentials.
	 */
	publish: z.boolean().optional(),
});
export const finalizeResponse = z.object({
	state: z.enum(["completed", "failed", "cancelled"]).nullable(),
});
/** The write was fenced (stale lease) or refused because the turn was stopped. */
export const writeResponse = z.object({
	ok: z.boolean(),
	reason: z.enum(["lease-lost", "cancelled"]).optional(),
});
export type TurnBoxWriteResponse = z.infer<typeof writeResponse>;

export const historyRequest = z.object({
	/** The version the box already holds; the edge answers `notModified`. */
	version: z.string().max(64).optional(),
});
export const historyResponse = z.union([
	z.object({ notModified: z.literal(true), version: z.string() }),
	z.object({
		notModified: z.literal(false).default(false),
		version: z.string(),
		messages,
		items,
	}),
]);
export type TurnBoxHistoryResponse = z.infer<typeof historyResponse>;

export const reserveRequest = z.object({
	tokens: z.number().int().min(1).max(50_000_000),
});
export const reserveResponse = z.object({
	ok: z.boolean(),
	reason: z.enum(["lease-lost", "budget"]).optional(),
	message: z.string().optional(),
});
export const cancelResponse = z.object({ cancelRequested: z.boolean() });

export const errorResponse = z.object({
	error: z.enum([
		"unauthorized",
		"forbidden",
		"lease-lost",
		"cancelled",
		"too-large",
		"bad-request",
		"unavailable",
		"not-served",
	]),
});

/** Messages over the per-turn WebSocket (box <-> the chat's Durable Object). */
export const boxSocketMessage = z.discriminatedUnion("t", [
	/** Coalesced progress: the turn's full item list (the latest replaces older ones). */
	z.object({ t: z.literal("progress"), seq: z.number().int(), items }),
	z.object({ t: z.literal("renew"), seq: z.number().int() }),
]);
export type TurnBoxSocketMessage = z.infer<typeof boxSocketMessage>;
export const edgeSocketMessage = z.discriminatedUnion("t", [
	z.object({
		t: z.literal("ack"),
		seq: z.number().int(),
		ok: z.boolean(),
		inbox: z.boolean().optional(),
	}),
	z.object({ t: z.literal("cancel") }),
	z.object({ t: z.literal("lease-lost") }),
]);
export type TurnBoxEdgeSocketMessage = z.infer<typeof edgeSocketMessage>;

/** Per-turn budget this slice is sized for (docs/turn-runner-boxes.md). */
export const TURN_BOX_REQUEST_BUDGET = {
	steps: 40,
	workerRequests: 100,
	durableObjectRequests: 10,
} as const;

const portText = z.string().min(1).max(512);
const portKey = z.string().min(1).max(256);
const optionalText = portText.nullable();

/**
 * The turn "ports" the edge serves to a box (docs/turn-runner-boxes.md, table
 * of dependencies): one endpoint, `POST /box/v1/port {op, args}`, lease-checked
 * like every other grant endpoint. The user, the chat and the turn are NEVER
 * arguments: the edge takes them from the grant, so a box can only reach its
 * own turn's data. What is not listed here is not served.
 */
export const boxPortArgs = {
	// Reads of the chat, its project and its user.
	sessionMetadata: z.object({ sessionId: z.uuid() }),
	sessionAncestors: z.object({}),
	importedSessions: z.object({ projectId: portText }),
	projectYMode: z.object({ projectId: portText }),
	/** The connection WITHOUT its sealed credential. */
	modelConnection: z.object({ id: portKey }),
	lifecycleContinuations: z.object({}),
	conversationPointCodeRef: z.object({ messageId: portKey }),
	verificationBaseline: z.object({ directory: z.string().max(4096) }),
	preparedCheckoutDirectory: z.object({ projectId: optionalText }),
	projectDerivedValue: z.object({ projectId: portText, key: portKey }),
	sessionDerivedValue: z.object({ key: portKey }),
	pluginSkillIndex: z.object({ projectId: optionalText }),
	pluginSkillBody: z.object({ installId: portText, skill: portText }),
	harnessVariant: z.object({}),
	isDevEvalUser: z.object({}),
	otherRunningTurnOnMachine: z.object({ vm: portText }),
	/** Secret NAMES and kinds only: never a value, an env file or a redaction list. */
	projectSecretNames: z.object({}),
	// Writes.
	savePreparedCheckoutDirectory: z.object({ directory: z.string().max(4096) }),
	saveSessionDerivedValue: z.object({ key: portKey, value: z.unknown() }),
	archiveContext: z.object({ messages }),
	cloudProjectReport: z.object({ items }),
	saveTaskResult: z.object({
		summary: z.string().max(100_000),
		eventType: z.enum(["completed", "failed"]),
	}),
	releaseHeldTaskEvents: z.object({}),
	enqueueTaskEvent: z.object({ eventId: portText.optional() }),
	/** Batched: the loop emits one event per tool and model call. */
	analytics: z.object({
		events: z
			.array(
				z.object({
					event: z.custom<ServerAnalyticsEvent>(
						(event) =>
							typeof event === "string" &&
							Object.hasOwn(serverAnalyticsEvents, event),
					),
					properties: z.record(z.string(), z.unknown()),
					identity: z.object({
						key: portKey,
						timestamp: z.number(),
						setOnce: z.record(z.string(), z.string()).optional(),
					}),
				}),
			)
			.min(1)
			.max(50),
	}),
	userHubNote: z.object({ topics: z.array(portText).max(32) }),
	// The turn ended on a card for the person: the project's crew hears it.
	crewWaiting: z.object({
		projectId: portText,
		ySquaredId: portText.nullable(),
		waitingOn: portText,
	}),
	// The chat's peer inbox: read, then accept what a checkpoint has saved.
	peerInboxRead: z.object({}),
	peerInboxAccept: z.object({ ids: z.array(portText).min(1).max(16) }),
	coordinateTurn: z.object({
		action: z.enum(["acquire", "renew", "release", "cancel"]),
	}),
	/**
	 * The edge writes the turn's project secrets (env file) onto the chat's
	 * VM with its own machines: the values never reach the box, which sends
	 * no argument.
	 */
	writeSecretsToVm: z.object({}),
	/**
	 * The edge commits the turn's changes in the chat's checkout (the same
	 * `commitSessionTurn` the Durable Object calls). Answers null (nothing to
	 * commit for this chat) or the notice and whether a push is still pending;
	 * the push and pull request run at `finalize` (`publish`).
	 */
	commitTurn: z.object({ items }),
	/**
	 * The edge captures the code recovery point of a user message
	 * (`ensureConversationCodePoint`) on the chat's own VM (taken from the
	 * chat, never from the box); `cwd` is the checkout path the box read.
	 */
	ensureCodePoint: z.object({ messageId: portKey, cwd: z.string().max(4096) }),
} as const;
export type BoxPortOp = keyof typeof boxPortArgs;
export const boxPortOps = Object.keys(boxPortArgs) as BoxPortOp[];
export type BoxPortArgs<Op extends BoxPortOp> = z.infer<
	(typeof boxPortArgs)[Op]
>;

export const portRequest = z.object({
	op: z.string().min(1).max(64),
	args: z.unknown().optional(),
});
/** `result` is the port function's JSON result; `notServed`: the edge has no handler (yet). */
export const portResponse = z.object({
	ok: z.literal(true),
	result: z.unknown(),
});

/** A port call reached outside the grant's own turn, chat or project (answered 403). */
export class TurnBoxPortForbidden extends Error {
	constructor(readonly op: string) {
		super(`${op} is outside this turn's scope.`);
		this.name = "TurnBoxPortForbidden";
	}
}
