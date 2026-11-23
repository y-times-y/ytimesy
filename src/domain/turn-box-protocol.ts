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
	/** POST, no identity: an EC2 box proves its instance role through STS and is given an identity. */
	enroll: `${TURN_BOX_API_PREFIX}/enroll`,
	/** GET, by identity: where a new box downloads its program (a short-lived link). */
	bundle: `${TURN_BOX_API_PREFIX}/bundle`,
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
/** A box gzips a request body larger than this (a long chat's history). */
export const TURN_BOX_GZIP_ABOVE_BYTES = 256 * 1024;
/** Largest body the edge inflates a gzipped request to. */
export const TURN_BOX_MAX_INFLATED_BYTES = 64 * 1024 * 1024;
/** Largest history the edge returns; a bigger turn must be compacted first. */
export const TURN_BOX_MAX_HISTORY_BYTES = 16 * 1024 * 1024;
/**
 * A turn claimed with more history than this runs in its chat's Durable
 * Object instead: it can still grow during the turn within the limit above
 * (a long Y² chat once had 8.5 MB and failed on a box).
 */
export const TURN_BOX_HANDOFF_HISTORY_BYTES = 8 * 1024 * 1024;
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
	refreshIdentity: z.literal(true).optional(),
});
export const registerResponse = z.object({
	ok: z.literal(true),
	/**
	 * The program version published now: a box running another finishes its
	 * turns, takes no new ones and restarts on it (box-runner.ts).
	 */
	latestVersion: z.string().max(128).optional(),
	identity: z
		.string()
		.max(1024)
		.regex(/^ytbi1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
		.optional(),
});
export const claimRequest = z.object({
	perUserLimit: z.number().int().min(1).max(64).optional(),
	/**
	 * A long poll: with nothing queued the edge keeps looking (every
	 * TURN_BOX_CLAIM_RECHECK_MS) for up to this long before answering 204, so
	 * an idle box makes one Worker request per wait instead of one per poll.
	 */
	waitMs: z.number().int().min(0).max(25_000).optional(),
});
/** How often a long-polled claim looks at the queue again. */
export const TURN_BOX_CLAIM_RECHECK_MS = 2_000;
/** The longest a box asks the edge to hold an empty claim. */
export const TURN_BOX_CLAIM_WAIT_MS = 20_000;
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
	/** A Claude Code turn's MCP tools, for the edge to list to the run (claude-relay.ts). */
	z.object({
		t: z.literal("claude-tools"),
		seq: z.number().int(),
		definitions: z.array(z.unknown()).max(1000),
	}),
	/** The relayed calls the box has taken (it runs each once). */
	z.object({
		t: z.literal("claude-ack"),
		seq: z.number().int(),
		ids: z.array(z.string().min(1).max(64)).max(200),
	}),
	/** A relayed call's answer. */
	z.object({
		t: z.literal("claude-reply"),
		seq: z.number().int(),
		id: z.string().min(1).max(64),
		reply: z.object({
			text: z.string(),
			isError: z.boolean(),
			content: z.array(z.unknown()).max(1000).optional(),
		}),
	}),
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
	/**
	 * One of the Claude Code run's MCP calls, relayed by the edge to the box
	 * running the turn (claude-relay.ts); sent again until the box acks it.
	 */
	z.object({
		t: z.literal("claude-call"),
		id: z.string().min(1).max(64),
		name: z.string().min(1).max(256),
		args: z.record(z.string(), z.unknown()),
		invocationId: z.string().max(256).optional(),
		timeoutMs: z.number().int().positive(),
		graceMs: z.number().int().nonnegative(),
	}),
]);
export type TurnBoxEdgeSocketMessage = z.infer<typeof edgeSocketMessage>;

/** Per-turn budget this slice is sized for (docs/turn-runner-boxes.md). */
export const TURN_BOX_REQUEST_BUDGET = {
	steps: 40,
	workerRequests: 100,
	durableObjectRequests: 10,
} as const;

/**
 * The helper (subagent) operations a box's agent tools reach through the
 * edge (`subagent` port, turn-box-subagent-port.ts): the members of
 * SubagentToolDeps that read or write the database or act on another VM.
 * Lead mode fusion's three (round start, sidekick state, retirement) are not
 * served: routing keeps fusion turns off boxes.
 */
export const SUBAGENT_PORT_DEPS = [
	"ancestors",
	"tree",
	"itemsOfKinds",
	"openTask",
	"saveSpec",
	"fork",
	"saveProviderRef",
	"mergeFork",
	"start",
	"routes",
	"markFailed",
	"releaseStart",
	"takeReport",
	"message",
	"queueAfterTurn",
	"interrupt",
	"stop",
	"usageWindowsOpen",
] as const;
export type SubagentPortDep = (typeof SUBAGENT_PORT_DEPS)[number];

/**
 * The super agent's (Y²) operations a box's Y² tools reach through the edge
 * (`ySquared` port, turn-box-y-squared-port.ts): the members of the tools'
 * Deps that read the database, the project's crew or another thread.
 */
export const Y_SQUARED_PORT_DEPS = [
	"list",
	"metadata",
	"outcome",
	"canvas",
	"download",
	"send",
	"stop",
	"crewList",
	"crewThread",
	"crewReconcile",
	"crewNoteY2Sent",
	"crewSchedule",
] as const;
export type YSquaredPortDep = (typeof Y_SQUARED_PORT_DEPS)[number];

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
	/**
	 * A Codex subscription turn: the catalog row, effort and cache key the
	 * edge chose with the account's token (which never leaves the edge).
	 */
	codexSelection: z.object({
		modelId: portText,
		reasoning: portText.optional(),
		fast: z.boolean(),
		alternateContext: z.boolean(),
		cacheScopeId: portKey,
	}),
	/** Whether the account has a Codex sign-in the turn can use. */
	codexAuth: z.object({}),
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
		action: z.enum(["acquire", "renew", "release", "resume", "cancel"]),
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
	/**
	 * One helper operation of the turn's own agent tools. Every chat, VM and
	 * user it names is checked against the turn's own chat and its helpers
	 * (the edge's handler); records travel as ids and are reloaded there.
	 */
	subagent: z.object({
		dep: z.enum(SUBAGENT_PORT_DEPS),
		args: z.array(z.unknown()).max(8),
	}),
	/**
	 * Cross-chat memory for the turn's own chat (turn-box-memory-port.ts): the
	 * edge reads the memory repo, embeds, clones onto the chat's own VM and
	 * queues the save hook; the box applies the recalled parts. `wording` and
	 * `writer` are the harness variant's memory options.
	 */
	memory: z.object({
		op: z.enum([
			"init",
			"prepareVm",
			"releaseVm",
			"parts",
			"recordSaved",
			"afterTurn",
		]),
		wording: portText.optional(),
		writer: portText.optional(),
		vm: portText.nullable().optional(),
		scrub: z.boolean().optional(),
		cwd: z.string().max(4096).optional(),
		messages: messages.optional(),
		items: items.optional(),
	}),
	/**
	 * Plain git on the turn's own VM (turn-box-machine-git-port.ts): the edge
	 * mints the step's git proxy token and sets git up, or removes and
	 * revokes it. `vm` must be the chat's own.
	 */
	machineGit: z.object({
		op: z.enum(["prepareVm", "releaseVm"]),
		vm: portText.nullable().optional(),
	}),
	/**
	 * A tool the edge runs whole for the turn's own chat (turn-box-tool-port.ts):
	 * saving or describing a secret, asking for a push approval. `cwd` is the
	 * checkout path the box read (for counting the push's commits).
	 */
	remoteTool: z.object({
		tool: z.enum([
			"save_project_secret",
			"describe_secret",
			"request_push_approval",
			"save_project_environment",
		]),
		input: z.unknown(),
		cwd: z.string().max(4096).optional(),
	}),
	/**
	 * The chat's tool-call receipts (agent-task-command-receipts.ts), which
	 * keep a resumed step from running a journaled tool call twice.
	 */
	commandReceipt: z.object({
		op: z.enum(["claim", "complete", "renew", "retained"]),
		requestId: portText.optional(),
		requestIds: z.array(portText).max(64).optional(),
		response: z.record(z.string(), z.unknown()).optional(),
	}),
	/** The highest revision a canvas with this title has in the turn's chat. */
	canvasRevision: z.object({ title: z.string().min(1).max(200) }),
	/** The next route after this turn's route failed (planModelFailover on the turn's own row). */
	planFailover: z.object({
		reason: z.string().min(1).max(64),
		child: z.boolean(),
		allowCustom: z.boolean(),
	}),
	/** One of the super agent's tool operations (turn-box-y-squared-port.ts). */
	ySquared: z.object({
		dep: z.enum(Y_SQUARED_PORT_DEPS),
		args: z.array(z.unknown()).max(8),
	}),
	/** A helper's step count and its own helpers' token use (guardSubagentStep). */
	helperStep: z.object({ op: z.enum(["record", "descendantUsage"]) }),
	/**
	 * A helper's read-only memory (subagentMemory), run by the edge: whether
	 * there is any, one of its two read tools, or the parts its request gets.
	 */
	helperMemory: z.object({
		op: z.enum(["available", "tool", "attach"]),
		wording: portText.optional(),
		tool: z.enum(["search_memory", "read_memory"]).optional(),
		input: z.unknown().optional(),
		messages: messages.optional(),
		items: items.optional(),
	}),
	/** Push cards of this chat answered meanwhile, claimed once (gitPushRequests.claimUnnoticed). */
	pushNotices: z.object({}),
	/** The turn's MCP tools as data (names, descriptions, input schemas); credentials stay on the edge. */
	mcpListing: z.object({}),
	/** One MCP tool call, made by the edge on one of the turn's own servers. */
	mcpCall: z.object({ server: portText, tool: portText, input: z.unknown() }),
	/**
	 * A Claude Code turn on a box (turn-box-claude-port.ts): its runner box
	 * (chosen and signed for by the edge), the run's grant, the chat's Claude
	 * session record and transcripts, and the plan's status.
	 */
	claude: z.discriminatedUnion("op", [
		z.object({
			op: z.literal("runner"),
			reader: z.boolean(),
			ySquared: z.boolean(),
		}),
		z.object({
			op: z.literal("exec"),
			baseUrl: portText,
			command: z
				.string()
				.min(1)
				.max(256 * 1024),
			timeoutMs: z
				.number()
				.int()
				.positive()
				.max(15 * 60_000),
		}),
		z.object({
			op: z.literal("write"),
			baseUrl: portText,
			path: z.string().min(1).max(4096),
			contents: z.string().max(TURN_BOX_MAX_INFLATED_BYTES),
		}),
		z.object({
			op: z.literal("read"),
			baseUrl: portText,
			path: z.string().min(1).max(4096),
		}),
		z.object({ op: z.literal("disk"), baseUrl: portText }),
		z.object({ op: z.literal("grant") }),
		z.object({ op: z.literal("sessionRead") }),
		z.object({
			op: z.literal("sessionSave"),
			record: z.object({
				claudeSessionId: portText,
				transcriptPath: z.string().max(4096).nullable(),
				cwd: z.string().min(1).max(4096),
			}),
		}),
		z.object({
			op: z.literal("transcriptUpload"),
			claudeSessionId: portText,
			text: z.string().max(TURN_BOX_MAX_INFLATED_BYTES),
		}),
		z.object({
			op: z.literal("transcriptDownload"),
			path: z.string().min(1).max(4096),
		}),
		z.object({ op: z.literal("subscription") }),
	]),
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
