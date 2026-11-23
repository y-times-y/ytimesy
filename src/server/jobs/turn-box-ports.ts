import { jsonSchema, type ModelMessage, type ToolSet, tool } from "ai";
import { isUserRequestMessage } from "#/domain/api-conversation";
import {
	CoordinationFailure,
	type TurnControlAction,
} from "#/domain/conversation-turn-control";
import { attachedMemory, withMemoryParts } from "#/domain/memory-repo";
import {
	type PeerInboxRow,
	planPeerInjection,
} from "#/domain/peer-inbox-injection";
import { agentSecretsEnvFile } from "#/domain/project-secret";
import type { SessionItem } from "#/domain/session-item";
import type {
	BoxPortArgs,
	BoxPortOp,
	SubagentPortDep,
	YSquaredPortDep,
} from "#/domain/turn-box-protocol";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import { subscriptionErrorOf } from "#/domain/turn-box-subscription";
import type { CodexSelection } from "../adapters/codex-subscription-runtime";
import type { YSquaredCrewClient } from "../adapters/y-squared-crew-client";
import type { MachineGitStep } from "../services/machine-git";
import type { McpCatalogEntry } from "../services/mcp-tools";
import type { RemoteCommandReceipts } from "../services/remote-command-receipts";
import type { SubagentToolDeps } from "../services/subagent-tools";
import type { SubagentMemory, TurnMemory } from "../services/turn-memory";
import type { YSquaredToolDeps } from "../services/y-squared-tools";
import type { TurnBoxTurnSession } from "./turn-box-client";
import {
	TurnPortFailed,
	type TurnPorts,
	TurnPortUnavailable,
} from "./turn-ports";

/**
 * The turn runner box's `TurnPorts` (docs/turn-runner-boxes.md): every
 * member goes to the edge through the typed client, so this file and what it
 * imports hold no database, provider key or vault key. Members the edge does
 * not serve throw TurnPortUnavailable (listed in BOX_PORTS_UNAVAILABLE and in
 * the doc's table); a few degrade on purpose and say so below.
 */

/** Ports with no edge endpoint: they throw TurnPortUnavailable on a box. */
export const BOX_PORTS_UNAVAILABLE = [
	// Post-step GitHub publish/PR handoff and the VM: need the edge's Freestyle/GitHub credentials.
	"saveAccountWideSecret",
	"saveVisibleProjectSecret",
	"setSecretDescription",
	// Claude Code box tool grants and its subscription are never run on a box (Codex and Grok are: stage 3).
	"turnBoxToolIdentity",
	"recordTurnBoxToolIdentity",
	"clearTurnBoxToolIdentity",
	"pinnedClaudeRunner",
	// Harness evaluation runs stay in Durable Objects.
	"evaluationRunForTask",
	"assertEvaluationActive",
	"recordEvaluationUsage",
	"reserveEvaluationRequest",
	// Push approval records.
	"gitPushRequests",
] as const;

export type BoxTurnPorts = TurnPorts & {
	/** Sends the analytics the step buffered; call at the end of a step and before finalize. */
	flush(): Promise<void>;
};

const ANALYTICS_BATCH = 20;
/** The edge confirmed the lease this recently (a renewal, or a checkpoint's own): no renewal request. */
const RENEW_SKIP_MS = 5_000;
/** An empty peer inbox is read again after this long. */
const INBOX_RECHECK_MS = 10_000;

export function boxTurnPorts(session: TurnBoxTurnSession): BoxTurnPorts {
	const turn = session.turn;
	const call = <T>(op: BoxPortOp, args: unknown) =>
		session.port(op, args as BoxPortArgs<typeof op>) as Promise<T>;
	const unavailable = (name: string) => () => {
		throw new TurnPortUnavailable(name);
	};
	/** A box serves its own turn only: a port call naming another user or chat is refused at once. */
	const ownUser = (userId: string) => {
		if (userId !== turn.user_id) throw new TurnBoxPortForbidden("user");
	};
	const ownSession = (sessionId: string) => {
		if (sessionId !== turn.session_id)
			throw new TurnBoxPortForbidden("session");
	};

	const analytics: BoxPortArgs<"analytics">["events"] = [];
	const flush = async () => {
		while (analytics.length) {
			const events = analytics.splice(0, 50);
			// Best effort, like the Durable Object's own telemetry.
			await call("analytics", { events }).catch(() => undefined);
		}
	};
	// Reads that stay fixed for a turn are asked once (the Durable Object
	// memoises the same ones per turn with turnMemo): each is a Worker request
	// here. A failed read is not kept.
	const memo = new Map<string, Promise<unknown>>();
	const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
		let loading = memo.get(key) as Promise<T> | undefined;
		if (!loading) {
			loading = load();
			memo.set(key, loading);
			loading.catch(() => memo.delete(key));
		}
		return loading;
	};
	let coordinated = false;
	/** When this box last acquired or renewed the chat's coordination lease. */
	let coordinationRefreshedAt = 0;
	let inboxEmptyAt = Number.NEGATIVE_INFINITY;
	let savedDirectory: string | undefined;
	/**
	 * The chat's lock through the edge. An edge answer of 5xx or 429 (the
	 * edge or the chat's object restarting for a deploy) is the same
	 * retryable CoordinationFailure the chat's object reports, so a turn that
	 * has not started waits it out instead of failing (2026-11-21: a box turn
	 * failed on "Turn port coordinateTurn failed (503)").
	 */
	const coordinateTurn = async (action: TurnControlAction) => {
		try {
			return await call<boolean>("coordinateTurn", { action });
		} catch (error) {
			if (
				error instanceof TurnPortFailed &&
				(error.status === 429 || error.status >= 500)
			)
				throw new CoordinationFailure(
					action,
					{ kind: "http", status: error.status },
					1,
				);
			if (error instanceof TypeError)
				throw new CoordinationFailure(
					action,
					{ kind: "transport", category: "network" },
					1,
				);
			throw error;
		}
	};
	const sdk = session.modelSdkSettings();
	const adapters = session.adapters();

	const ports: TurnPorts = {
		// The edge confirmed the lease a moment ago (a checkpoint renews it too).
		renewApiTurn: (async () =>
			session.renewedWithin(RENEW_SKIP_MS)
				? true
				: adapters.renewApiTurn()) as unknown as TurnPorts["renewApiTurn"],
		checkpointApiTurn:
			adapters.checkpointApiTurn as unknown as TurnPorts["checkpointApiTurn"],
		publishApiTurnProgress:
			adapters.publishApiTurnProgress as unknown as TurnPorts["publishApiTurnProgress"],
		finalizeApiTurn:
			adapters.finalizeApiTurn as unknown as TurnPorts["finalizeApiTurn"],
		apiTurnCancelRequested:
			adapters.apiTurnCancelRequested as unknown as TurnPorts["apiTurnCancelRequested"],
		// The edge's model proxy reserves each request's tokens itself.
		reserveApiTokens: adapters.reserveApiTokens,
		otherRunningTurnOnMachine: async (userId, _turnId, vm) => {
			ownUser(userId);
			return call("otherRunningTurnOnMachine", { vm });
		},
		// Acquired once per turn; the box's socket and its lease renewals keep
		// the turn tied to the room. A renewal is still sent (the room's lease
		// is 30 s), a release once at the end.
		coordinateConversationTurn: async (action) => {
			if (action === "acquire") {
				// A later step of the same turn holds the lease already; it is
				// refreshed here (the room's lease lasts 30 s, and a step's own
				// renewal only starts after 10 s, so steps shorter than that
				// once let it lapse mid-turn: a helper was stopped, 2026-11-22).
				if (coordinated) {
					if (Date.now() - coordinationRefreshedAt < 10_000) return true;
					const held = await coordinateTurn("renew");
					coordinated = held !== false;
					if (coordinated) coordinationRefreshedAt = Date.now();
					return held;
				}
				const held = await coordinateTurn(action);
				coordinated = held !== false;
				if (coordinated) coordinationRefreshedAt = Date.now();
				return held;
			}
			if (action === "release") coordinated = false;
			const answer = await coordinateTurn(action);
			if (action === "renew" && answer !== false)
				coordinationRefreshedAt = Date.now();
			return answer;
		},

		agentSessionMetadataForOwner: async (userId, sessionId) => {
			ownUser(userId);
			return once(`meta:${sessionId}`, () =>
				call("sessionMetadata", { sessionId }),
			);
		},
		subagentAncestors: async (userId, sessionId) => {
			ownUser(userId);
			ownSession(sessionId);
			return call("sessionAncestors", {});
		},
		projectImportedSessions: async (userId, projectId) => {
			ownUser(userId);
			return once(`imported:${projectId}`, () =>
				call("importedSessions", { projectId }),
			);
		},
		projectYMode: async (userId, projectId) => {
			ownUser(userId);
			return once(`ymode:${projectId}`, () =>
				call("projectYMode", { projectId }),
			);
		},
		loadModelConnection: (async (userId: string, id: string) => {
			ownUser(userId);
			return once(`conn:${id}`, () => call("modelConnection", { id }));
		}) as unknown as TurnPorts["loadModelConnection"],
		completedLifecycleContinuations: async (sessionId, turnId) => {
			ownSession(sessionId);
			if (turnId !== turn.id) throw new TurnBoxPortForbidden("turn");
			return call("lifecycleContinuations", {});
		},
		conversationPointCodeRef: async (userId, sessionId, messageId) => {
			ownUser(userId);
			ownSession(sessionId);
			return (
				(await once(`code-ref:${messageId}`, () =>
					call<string | null>("conversationPointCodeRef", { messageId }),
				)) ?? undefined
			);
		},
		readVerificationBaseline: async (userId, sessionId, directory) => {
			ownUser(userId);
			ownSession(sessionId);
			return once(`baseline:${directory}`, () =>
				call("verificationBaseline", { directory }),
			);
		},
		readPreparedCheckoutDirectory: async (userId, sessionId, projectId) => {
			ownUser(userId);
			ownSession(sessionId);
			return once(`checkout-dir:${projectId}`, () =>
				call("preparedCheckoutDirectory", { projectId }),
			);
		},
		savePreparedCheckoutDirectory: async (userId, sessionId, directory) => {
			ownUser(userId);
			ownSession(sessionId);
			// The loop saves it more than once per turn: the same path once.
			if (savedDirectory === directory) return;
			await call("savePreparedCheckoutDirectory", { directory });
			savedDirectory = directory;
		},
		readProjectDerivedValue: async (userId, projectId, key) => {
			ownUser(userId);
			return once(`project-value:${projectId}:${key}`, () =>
				call("projectDerivedValue", { projectId, key }),
			);
		},
		readSessionDerivedValue: async (userId, sessionId, key) => {
			ownUser(userId);
			ownSession(sessionId);
			return once(`session-value:${key}`, () =>
				call("sessionDerivedValue", { key }),
			);
		},
		saveSessionDerivedValue: async (userId, sessionId, key, value) => {
			ownUser(userId);
			ownSession(sessionId);
			await call("saveSessionDerivedValue", { key, value });
			memo.delete(`session-value:${key}`);
		},
		enabledPluginSkillIndex: async (userId, projectId) => {
			ownUser(userId);
			return once(`plugins:${projectId}`, () =>
				call("pluginSkillIndex", { projectId }),
			);
		},
		pluginSkillBody: async (userId, installId, skill) => {
			ownUser(userId);
			return call("pluginSkillBody", { installId, skill });
		},
		harnessVariantForUser: async (userId) => {
			ownUser(userId);
			return once("variant", () => call("harnessVariant", {}));
		},
		isDevEvalUser: async (userId) => {
			ownUser(userId);
			return once("dev-eval", () => call("isDevEvalUser", {}));
		},
		// MCP servers carry credentials (headers, sealed OAuth): never served;
		// the box's MCP tools come from the edge (mcpTools below).
		connectableMcpServers: async () => [],

		saveAgentTaskResultAndEvent: async (input) =>
			call("saveTaskResult", {
				summary: input.summary,
				eventType: input.eventType,
			}),
		enqueueAgentTaskEvent: (async (eventId?: string) => {
			await call("enqueueTaskEvent", eventId ? { eventId } : {});
		}) as unknown as TurnPorts["enqueueAgentTaskEvent"],
		captureServerAnalytics: (async (
			userId: string,
			event: string,
			properties: Record<string, unknown>,
			identity: {
				key: string;
				timestamp: Date;
				setOnce?: Record<string, string>;
			},
		) => {
			ownUser(userId);
			analytics.push({
				event: event as BoxPortArgs<"analytics">["events"][number]["event"],
				properties,
				identity: {
					key: identity.key,
					timestamp: identity.timestamp.getTime(),
					setOnce: identity.setOnce,
				},
			});
			if (analytics.length >= ANALYTICS_BATCH) await flush();
		}) as unknown as TurnPorts["captureServerAnalytics"],
		noteUserHub: (userId, topics) => {
			if (userId !== turn.user_id) return;
			void call("userHubNote", { topics: [...topics] }).catch(() => undefined);
		},
		noteCrewWaiting: (hint) => {
			if (hint.userId !== turn.user_id) return;
			void call("crewWaiting", {
				projectId: hint.projectId,
				ySquaredId: hint.ySquaredId,
				waitingOn: hint.waitingOn,
			}).catch(() => undefined);
		},
		injectServerPeerMessages: async (
			recipientId,
			history,
			checkpoint,
			delivered = () => false,
			onSetupCatchUp,
			sentUserMessagesOnly = false,
		) => {
			ownSession(recipientId);
			// An empty inbox is asked again no sooner than INBOX_RECHECK_MS: the Durable
			// Object reads it every step, which here is a Worker request each; a
			// message sent meanwhile reaches the turn that much later.
			if (Date.now() - inboxEmptyAt < INBOX_RECHECK_MS) return history;
			const rows = await call<PeerInboxRow[]>("peerInboxRead", {});
			if (!rows.length) {
				inboxEmptyAt = Date.now();
				return history;
			}
			// The same decision the Durable Object takes over its own read.
			const plan = planPeerInjection(rows, history, {
				delivered,
				sentUserMessagesOnly,
			});
			if (plan.catchUp) onSetupCatchUp?.();
			if (!plan.delivering.length) return history;
			// Persist the history first; the rows are accepted only after.
			await checkpoint(plan.injected, plan.users);
			await call("peerInboxAccept", { ids: plan.delivering });
			return plan.injected;
		},
		archiveModelContext: async (userId, sessionId, messages) => {
			ownUser(userId);
			ownSession(sessionId);
			return call("archiveContext", { messages });
		},
		// Called after finalize: the edge records the report there.
		recordCloudProjectReport: async (_owner, turnId) => {
			if (turnId !== turn.id) throw new TurnBoxPortForbidden("turn");
		},

		// Secret NAMES only: the values stay on the edge (the VM's env file is
		// written there, by the tool bridge, not here); no redaction list is
		// needed on a box because the box never holds a value.
		loadAgentProjectSecrets: async (userId, projectId) => {
			ownUser(userId);
			const { names } = await once("secret-names", () =>
				call<{
					names: { name: string; kind: "build" | "runtime" | string }[];
				}>("projectSecretNames", {}),
			);
			void projectId;
			return {
				envFile: agentSecretsEnvFile([]),
				redact: [],
				names,
			} as Awaited<ReturnType<TurnPorts["loadAgentProjectSecrets"]>>;
		},

		modelAccess: {
			loadConnection: async (userId, connectionId) => {
				ownUser(userId);
				return (await once(`conn:${connectionId}`, () =>
					call("modelConnection", { id: connectionId }),
				)) as never;
			},
			// Fixed for a turn: asked once per (model, effort, speed, window).
			codexSelection: (input) =>
				once(`codex-selection:${JSON.stringify(input)}`, async () => {
					const answer = await call<{
						selection?: CodexSelection;
						refusal?: { code: string; body: unknown };
					}>("codexSelection", input);
					if (answer.selection) return answer.selection;
					throw (
						subscriptionErrorOf(
							answer.refusal?.code ?? null,
							answer.refusal?.body,
						) ?? new Error("Codex is unavailable.")
					);
				}),
			...sdk,
		},

		// Decisions (docs/turn-runner-boxes.md, "Whole turn on a box"):
		// - helpers' memory: helpers never run on a box;
		// - a push card answered while the turn runs gets no notice from a
		//   box (the edge-written push tools do not exist yet either);
		// - the workspace is prepared by the edge's vm/ensure (box-runner
		//   installs boxApiTurnWorkspace; this placeholder refuses).
		subagentToolDeps: boxSubagentToolDeps(call),
		savedCanvasRevision: (title) => call<number>("canvasRevision", { title }),
		machineGit: () => boxMachineGit(call),
		claudeBox: boxClaudeHost(session, call),
		ySquaredToolDeps: boxYSquaredToolDeps(call),
		planFailover: (input) => call("planFailover", input),
		helperStepDeps: {
			recordStep: async () =>
				call<{ steps: number; budget: never }>("helperStep", {
					op: "record",
				}),
			descendantUsage: async () =>
				call<never[]>("helperStep", { op: "descendantUsage" }),
		},
		helperReportsAtSettle: true,
		remoteTool: (name, input, cwd) =>
			call("remoteTool", { tool: name, input, ...(cwd ? { cwd } : {}) }),
		// The edge lists the turn's MCP tools once and makes each call.
		mcpTools: async () => {
			// As in the Durable Object, MCP never fails a turn: a listing the
			// edge could not give leaves the turn without MCP tools.
			// The fallback is kept for the turn too: one request per turn either way.
			const listing = await once("mcp-listing", () =>
				call<{
					catalog: McpCatalogEntry[];
					purposes: Record<string, string>;
					unavailable: string[];
				}>("mcpListing", {}).catch((error: unknown) => {
					console.warn("MCP tools could not be listed for a box turn.", {
						message: error instanceof Error ? error.message.slice(0, 200) : "",
					});
					return { catalog: [], purposes: {}, unavailable: [] };
				}),
			);
			const tools: ToolSet = {};
			for (const entry of listing.catalog)
				tools[entry.name] = tool({
					description: `[MCP ${entry.server}] ${entry.description || entry.tool}`,
					inputSchema: jsonSchema(entry.inputSchema),
					execute: (input: unknown) =>
						call("mcpCall", {
							server: entry.server,
							tool: entry.tool,
							input,
						}),
				});
			return {
				tools,
				catalog: listing.catalog,
				purposes: listing.purposes,
				unavailable: listing.unavailable,
				close: async () => undefined,
			};
		},
		// Memory: the edge reads and writes it on this chat (boxTurnMemory).
		turnMemory: (async (
			owner: { id: string; userId: string },
			options: { wording?: string; writer?: string } = {},
		) => {
			ownUser(owner.userId);
			ownSession(owner.id);
			return boxTurnMemory(call, options);
		}) as unknown as TurnPorts["turnMemory"],
		// A helper's read-only memory: run by the edge (helperMemory port).
		subagentMemory: (async (
			owner: { readonly id: string; readonly userId: string },
			options: { readonly wording?: string } = {},
		) => {
			ownUser(owner.userId);
			ownSession(owner.id);
			return boxHelperMemory(call, options);
		}) as unknown as TurnPorts["subagentMemory"],
		// Push cards answered meanwhile: claimed through the edge, once each.
		withPushResultNotices: (async (input: never) => {
			const { withPushResultNotices } = await import(
				"../services/push-approval"
			);
			return withPushResultNotices(input, {
				claimUnnoticed: (async (userId: string, sessionId: string) => {
					ownUser(userId);
					ownSession(sessionId);
					return call("pushNotices", {});
				}) as never,
			});
		}) as unknown as TurnPorts["withPushResultNotices"],
		deferredApiTurnWorkspace: unavailable("deferredApiTurnWorkspace"),

		// Post-settle work the edge does at finalize (adapters/turn-box-after-settle.ts):
		// the pull request link item, the next queued message, held reports.
		// The turn is no longer running by then, so a port call could not be
		// lease-checked: these are no-ops on the box.
		replaceSettledTurnItem: async () => false,
		startQueuedUserTurn: async () => false,
		releaseHeldAgentTaskEvents: async () => 0,

		// The edge commits (before finalize) with its own machines and pushes
		// (at finalize); the box learns the notice and that a push is pending.
		commitSessionTurn: async (_owner, items) => {
			const done = await call<{ notice?: string; publish: boolean } | null>(
				"commitTurn",
				{ items: [...items] },
			);
			if (!done) return undefined;
			if (done.publish) session.publishAfterFinalize = true;
			return {
				...(done.notice ? { notice: done.notice } : {}),
				// The push itself is the edge's, after finalize.
				...(done.publish ? { publish: async () => ({}) } : {}),
			};
		},
		ensureConversationCodePoint: async (
			userId,
			sessionId,
			messageId,
			ready,
		) => {
			ownUser(userId);
			ownSession(sessionId);
			await call("ensureCodePoint", { messageId, cwd: ready.cwd });
			memo.delete(`code-ref:${messageId}`);
		},
		// The edge writes the env file onto the VM; no value passes here.
		writeAgentProjectSecrets: async () => {
			await call("writeSecretsToVm", {});
		},
		saveAccountWideSecret: unavailable("saveAccountWideSecret"),
		saveVisibleProjectSecret: unavailable("saveVisibleProjectSecret"),
		setSecretDescription: unavailable("setSecretDescription"),
		turnBoxToolIdentity: unavailable("turnBoxToolIdentity"),
		recordTurnBoxToolIdentity: unavailable("recordTurnBoxToolIdentity"),
		clearTurnBoxToolIdentity: unavailable("clearTurnBoxToolIdentity"),
		pinnedClaudeRunner: unavailable("pinnedClaudeRunner"),
		// A Claude Code turn on a box: the plan's status, read by the edge.
		claudeSubscriptionStatus: (async () =>
			call("claude", { op: "subscription" })) as never,
		// Codex subscription turns run on a box (the edge holds the tokens):
		// the sign-in check is asked once per turn, and there is no catalog
		// to warm here (the edge reads it when the model is chosen).
		hasManagedCodexAuth: (async () =>
			once("codex-auth", () =>
				call<boolean>("codexAuth", {}),
			)) as unknown as TurnPorts["hasManagedCodexAuth"],
		warmCodexSubscriptionCatalog: (() =>
			undefined) as unknown as TurnPorts["warmCodexSubscriptionCatalog"],
		evaluationRunForTask: unavailable("evaluationRunForTask"),
		assertEvaluationActive: unavailable("assertEvaluationActive"),
		recordEvaluationUsage: unavailable("recordEvaluationUsage"),
		reserveEvaluationRequest: unavailable("reserveEvaluationRequest"),
		// Methods fail when called; building the push-approval tools does not.
		gitPushRequests: new Proxy(
			{},
			{
				get: (_target, method) => () => {
					throw new TurnPortUnavailable(`gitPushRequests.${String(method)}`);
				},
			},
		) as TurnPorts["gitPushRequests"],
	};
	return Object.assign(ports, { flush });
}

/** A box waits on a helper's report no more often than this (each look is a Worker request). */
const BOX_REPORT_POLL_MS = 5_000;

/**
 * The agent tools' operations on a box (docs/turn-runner-boxes.md, "Helpers
 * on a box"): the tool logic runs here; each database or helper-VM operation
 * is one `subagent` port call. Records cross as their id (the edge reloads
 * them) and machines are never sent (the edge uses its own).
 */
export function boxSubagentToolDeps(
	call: <T>(op: BoxPortOp, args: unknown) => Promise<T>,
): Partial<SubagentToolDeps> {
	const dep = <T>(name: SubagentPortDep, ...args: unknown[]) =>
		call<T>("subagent", { dep: name, args });
	const ref = (value: { readonly id: string }) => ({ id: value.id });
	const unavailable = (name: string) => () => {
		throw new TurnPortUnavailable(`subagent.${name}`);
	};
	return {
		sleep: (ms, signal) =>
			new Promise((resolve) => {
				const timer = setTimeout(done, Math.max(ms, BOX_REPORT_POLL_MS));
				function done() {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					resolve();
				}
				signal.addEventListener("abort", done, { once: true });
			}),
		ancestors: (userId, sessionId) => dep("ancestors", userId, sessionId),
		tree: (userId, rootId) => dep("tree", userId, rootId),
		itemsOfKinds: (userId, sessionId, kinds) =>
			dep("itemsOfKinds", userId, sessionId, [...kinds]),
		openTask: (input) => dep("openTask", input),
		saveSpec: (userId, sessionId, spec) =>
			dep("saveSpec", userId, sessionId, spec),
		fork: (input) =>
			dep("fork", { parentVm: input.parentVm, slug: input.slug }),
		saveProviderRef: (sessionId, providerRef) =>
			dep("saveProviderRef", sessionId, providerRef),
		mergeFork: (sessionId, fields) => dep("mergeFork", sessionId, fields),
		start: (scope, taskId, options) =>
			dep(
				"start",
				{ userId: scope.userId, sessionId: scope.sessionId },
				taskId,
				options,
			),
		routes: (userId) => dep("routes", userId),
		markFailed: (sessionId) => dep("markFailed", sessionId),
		releaseStart: (userId, projectId, taskId) =>
			dep("releaseStart", userId, projectId, taskId),
		takeReport: (childId) => dep("takeReport", childId),
		message: (sender, recipientId, message, requestId) =>
			dep("message", ref(sender), recipientId, message, requestId),
		queueAfterTurn: (sender, recipientId, message, requestId) =>
			dep("queueAfterTurn", ref(sender), recipientId, message, requestId),
		interrupt: (_machines, sender, recipientId, message, requestId) =>
			dep("interrupt", null, ref(sender), recipientId, message, requestId),
		stop: (sessionId, options) => dep("stop", sessionId, options ?? {}),
		usageWindowsOpen: async (userId) => {
			await dep("usageWindowsOpen", userId);
		},
		// Lead mode fusion: routing keeps it off boxes.
		markRoundStart: unavailable("markRoundStart"),
		saveSidekick: unavailable("saveSidekick"),
		retireSidekick: unavailable("retireSidekick"),
	} as Partial<SubagentToolDeps>;
}

/**
 * Cross-chat memory on a box (docs/turn-runner-boxes.md, "Memory on a box"):
 * every operation is the edge's (`memory` port, turn-box-memory-port.ts) on
 * this turn's own chat and VM; here only the recalled parts are added to the
 * current request. Memory never fails a turn: a failed call degrades to none.
 */
export async function boxTurnMemory(
	call: <T>(op: BoxPortOp, args: unknown) => Promise<T>,
	options: { readonly wording?: string; readonly writer?: string },
): Promise<TurnMemory | null> {
	const base = {
		...(options.wording ? { wording: options.wording } : {}),
		...(options.writer ? { writer: options.writer } : {}),
	};
	const memory = <T>(op: string, args: Record<string, unknown> = {}) =>
		call<T>("memory", { ...base, op, ...args });
	const quiet = <T>(work: Promise<T>, fallback: T) =>
		work.catch((error: unknown) => {
			console.warn("Memory is unavailable for this box step.", {
				message: error instanceof Error ? error.message.slice(0, 200) : "",
			});
			return fallback;
		});
	const init = await quiet(
		memory<{ mode: TurnMemory["mode"]; instructions: string } | null>("init"),
		null,
	);
	if (!init) return null;
	const tokens: string[] = [];
	const parts: TurnMemory["memoryParts"] = async (
		messages,
		items,
		workspace,
	) => {
		let at = -1;
		for (let index = messages.length - 1; index >= 0; index--)
			if (isUserRequestMessage(items, messages[index] as ModelMessage)) {
				at = index;
				break;
			}
		if (at < 0) return null;
		const current = messages[at] as ModelMessage;
		if (attachedMemory([current]).length) return null;
		// What the edge needs: the memory already shown, the request's text
		// (no image or file bytes) and the person's own messages.
		const shown = messages.filter(
			(message, index) => index !== at && attachedMemory([message]).length,
		);
		const request = {
			...current,
			content: Array.isArray(current.content)
				? (current.content as { type: string }[]).filter(
						(part) => part.type === "text",
					)
				: current.content,
		} as ModelMessage;
		const found = await memory<{
			parts: string[];
			recall: NonNullable<
				Awaited<ReturnType<TurnMemory["memoryParts"]>>
			>["recall"];
		} | null>("parts", {
			messages: [...shown, request],
			items: items.filter((item) => item.kind === "userMessage"),
			// The checkout may not be ready on a first request: the edge then
			// skips the missing-path marks, as the Durable Object does.
			...(await workspace().then(
				(ready) => ({ cwd: ready.cwd }),
				() => ({}),
			)),
		});
		return found ? { at, parts: found.parts, recall: found.recall } : null;
	};
	return {
		mode: init.mode,
		instructions: init.instructions,
		prepareVm: async (workspace, beforeVm) => {
			const minted = await quiet(
				memory<{ tokens: string[] }>("prepareVm", { vm: workspace.vm }),
				{ tokens: [] },
			);
			for (const token of minted.tokens) {
				tokens.push(token);
				beforeVm?.(token);
			}
		},
		vmTokens: () => tokens,
		// After finalize the box's port calls are no longer lease-checked, so
		// the edge releases the clone's token when the turn settles
		// (turn-box-edge-work.ts); a release earlier in the turn is tried here.
		releaseVm: async (workspace) => {
			const scrub = tokens.length > 0;
			tokens.length = 0;
			await memory("releaseVm", { vm: workspace?.vm ?? null, scrub }).catch(
				() => undefined,
			);
		},
		memoryParts: (messages, items, workspace) =>
			quiet(parts(messages, items, workspace), null),
		attach: async (messages, items, workspace) => {
			const found = await quiet(parts(messages, items, workspace), null);
			if (!found) return { messages, recall: null };
			if (!found.parts.length) return { messages, recall: found.recall };
			const next = [...messages];
			next[found.at] = withMemoryParts(
				messages[found.at] as { role: "user"; content: string },
				[...found.parts],
			) as ModelMessage;
			return { messages: next, recall: found.recall };
		},
		recordSaved: async (items, turnId) => {
			let user = items.length - 1;
			while (user >= 0 && items[user]?.kind !== "userMessage") user--;
			if (user < 0) return [...items];
			const tail = await quiet(
				memory<SessionItem[] | null>("recordSaved", {
					items: items.slice(user),
				}),
				null,
			);
			void turnId;
			return tail ? [...items.slice(0, user), ...tail] : [...items];
		},
		// The save hook runs after finalize, where the box's port calls are no
		// longer lease-checked: the edge queues it then (turn-box-edge-work.ts).
		afterTurn: async () => undefined,
	};
}

/** The chat's tool-call receipts through the edge (registered by box-runner.ts for the running turn's chat). */
export function boxCommandReceipts(
	port: (op: string, args: Record<string, unknown>) => Promise<unknown>,
): RemoteCommandReceipts {
	return {
		claim: async (requestId) =>
			(await port("claim", { requestId })) as Awaited<
				ReturnType<RemoteCommandReceipts["claim"]>
			>,
		complete: async (response) => {
			await port("complete", { response });
		},
		renew: async (requestId) => {
			await port("renew", { requestId });
		},
		retained: async (requestIds) =>
			new Map(
				(await port("retained", { requestIds: [...requestIds] })) as [
					string,
					unknown,
				][],
			),
	};
}

/**
 * Plain git on the VM for a turn on a box: the edge mints and sets up the
 * step's git proxy token (`machineGit` port, turn-box-machine-git-port.ts)
 * and answers it for redaction. Never fails a turn. A release after
 * finalize is refused (no lease); the edge releases when the turn settles.
 */
export function boxMachineGit(
	call: <T>(op: BoxPortOp, args: unknown) => Promise<T>,
): MachineGitStep {
	/** Whether this step set git up: a step that did not has nothing to release. */
	let prepared = false;
	return {
		prepareVm: async (workspace, beforeVm) => {
			prepared = true;
			const minted = await call<{ tokens: string[] } | null>("machineGit", {
				op: "prepareVm",
				vm: workspace.vm,
			}).catch(() => null);
			for (const token of minted?.tokens ?? []) beforeVm?.(token);
		},
		releaseVm: async (workspace) => {
			if (!prepared) return;
			prepared = false;
			await call("machineGit", {
				op: "releaseVm",
				vm: workspace?.vm ?? null,
			}).catch(() => undefined);
		},
	};
}

/**
 * The super agent's (Y²) tool operations on a box (docs/turn-runner-boxes.md,
 * "The super agent and helpers on a box"): the tools run here; each read,
 * crew call, send or stop is one `ySquared` port call, checked by the edge
 * against this turn's own Y² chat and project. Machines are never sent (the
 * edge uses its own); `now` stays local.
 */
export function boxYSquaredToolDeps(
	call: <T>(op: BoxPortOp, args: unknown) => Promise<T>,
): Partial<YSquaredToolDeps> {
	const dep = <T>(name: YSquaredPortDep, ...args: unknown[]) =>
		call<T>("ySquared", { dep: name, args });
	const crew: YSquaredCrewClient = {
		list: () => dep("crewList"),
		thread: (sessionId) => dep("crewThread", sessionId),
		reconcile: async (rows) => {
			await dep("crewReconcile", [...rows]);
		},
		noteY2Sent: async (sessionId) => {
			await dep("crewNoteY2Sent", sessionId);
		},
		noteWaiting: async () => undefined,
		schedule: (input, _target) => dep("crewSchedule", input),
	};
	return {
		list: (userId, projectId) => dep("list", userId, projectId),
		metadata: (userId, sessionId) => dep("metadata", userId, sessionId),
		outcome: (userId, sessionId) => dep("outcome", userId, sessionId),
		canvas: (userId, sessionId, title) =>
			dep("canvas", userId, sessionId, title),
		download: (userId, sessionId, id) => dep("download", userId, sessionId, id),
		send: (_machines, scope, input) => dep("send", scope, input),
		stop: (_machines, scope) => dep("stop", scope),
		// A crew answers through the edge; one that is missing there answers null.
		crew: () => crew,
	};
}

/**
 * A helper's read-only memory on a box: the edge says whether there is any,
 * runs its two read tools and gives the parts the current request gets.
 * Never fails a turn: a failed call reads as no memory, no hits.
 */
export async function boxHelperMemory(
	call: <T>(op: BoxPortOp, args: unknown) => Promise<T>,
	options: { readonly wording?: string },
): Promise<SubagentMemory | null> {
	const base = options.wording ? { wording: options.wording } : {};
	const available = await call<boolean>("helperMemory", {
		...base,
		op: "available",
	}).catch(() => false);
	if (!available) return null;
	// The tools' names, descriptions and schemas; their work is the edge's.
	const { memoryReadTools } = await import("../services/memory-read-tools");
	const shapes = memoryReadTools(() => ({}), {
		search: "search_memory",
		read: "read_memory",
	});
	const tools: ToolSet = Object.fromEntries(
		Object.entries(shapes).map(([name, shape]) => [
			name,
			{
				...shape,
				execute: async (input: unknown) =>
					call<string>("helperMemory", {
						...base,
						op: "tool",
						tool: name,
						input,
					}).catch(() => "Memory is unavailable right now."),
			},
		]),
	);
	return {
		tools,
		attach: async (messages, items) => {
			const unchanged = { messages, recall: null };
			const found = await call<Awaited<
				ReturnType<SubagentMemory["attach"]>
			> | null>("helperMemory", {
				...base,
				op: "attach",
				messages,
				items: [...items],
			}).catch(() => null);
			return found ?? unchanged;
		},
	};
}

/**
 * A Claude Code turn's step on this box (docs/turn-runner-boxes.md, "Claude
 * Code on a box"): every runner command, the run's grant and the chat's
 * Claude session go through the edge's `claude` port; the run's MCP calls
 * come over the turn's socket.
 */
function boxClaudeHost(
	session: TurnBoxTurnSession,
	call: <T>(op: BoxPortOp, args: unknown) => Promise<T>,
): NonNullable<TurnPorts["claudeBox"]> {
	const claude = <T>(args: BoxPortArgs<"claude">) => call<T>("claude", args);
	return {
		runner: async (facts) => {
			const chosen = await claude<{ baseUrl: string } | null>({
				op: "runner",
				...facts,
			});
			return chosen ? { baseUrl: chosen.baseUrl } : null;
		},
		host: {
			edgeOrigin: session.edgeOrigin(),
			machine: (runner) => ({
				shell: (command, timeoutMs) =>
					claude<{ exitCode: number; stdout: string; stderr: string }>({
						op: "exec",
						baseUrl: runner.baseUrl,
						command,
						timeoutMs: Math.min(timeoutMs, 15 * 60_000),
					}),
				writeFile: async (path, contents) => {
					await claude({
						op: "write",
						baseUrl: runner.baseUrl,
						path,
						contents,
					});
				},
				readFile: async (path) =>
					(
						await claude<{ contents: string | null }>({
							op: "read",
							baseUrl: runner.baseUrl,
							path,
						})
					).contents,
			}),
			diskShare: (runner) =>
				claude<number | null>({ op: "disk", baseUrl: runner.baseUrl }).catch(
					() => null,
				),
			issueGrant: () => claude<string>({ op: "grant" }),
			store: {
				readSession: () => claude({ op: "sessionRead" }),
				saveSession: async (record) => {
					await claude({ op: "sessionSave", record });
				},
				uploadTranscript: (claudeSessionId, text) =>
					claude<string>({ op: "transcriptUpload", claudeSessionId, text }),
				downloadTranscript: (path) =>
					claude<string>({ op: "transcriptDownload", path }),
				subscriptionStatus: () => claude({ op: "subscription" }),
			},
			relay: (handler) => session.claudeRelay(handler),
			publishTools: (definitions) => session.publishClaudeTools(definitions),
		},
	};
}
