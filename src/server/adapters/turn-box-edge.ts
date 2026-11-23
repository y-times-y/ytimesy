import { isXaiDirectEndpoint } from "#/domain/model-connection";
import { turnFailover } from "#/domain/model-failover";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import type { TurnBoxGrant } from "#/domain/turn-box-grant";
import type { TurnBoxModelAuthorization } from "#/domain/turn-box-model-proxy";
import type { BoxPortArgs } from "#/domain/turn-box-protocol";
import { settledHubTurnStatus } from "#/domain/user-hub";
import { xaiSubscriptionFetch } from "../auth/xai-subscription";
import type { TurnBoxEdgeOps } from "../edge/turn-box-routes";
import { connectionApiKey } from "../services/model-connections";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { modelConcurrencyLimits } from "./agent-capacity";
import type { ApiTurn } from "./api-turns";
import {
	apiTurnCancelRequested,
	apiTurnLeaseFreshSql,
	checkpointApiTurn,
	claimApiTurn,
	finalizeApiTurn,
	handClaimedApiTurnToObject,
	publishApiTurnProgress,
	readRunningApiTurn,
	readRunningApiTurnIdentity,
	releaseClaimedApiTurn,
	renewApiTurn,
} from "./api-turns";
import { reserveApiTokens } from "./api-usage-budget";
import { CODEX_BACKEND } from "./codex-subscription-runtime";
import { subscriptionFetch } from "./codex-subscription-transport";
import { coordinateConversationTurn } from "./conversation-turn-control";
import { database } from "./database";
import { loadModelConnection } from "./model-connections";
import { afterBoxTurnSettled } from "./turn-box-edge-work";
import { turnBoxPort } from "./turn-box-port-handlers";
import {
	registerTurnRunnerBox,
	turnRunnerBoxActive,
} from "./turn-runner-boxes";

/**
 * The edge's database side of the thin-client API for turn runner boxes.
 * It only composes the existing lease-checked writers of api-turns.ts (the
 * SQL predicate stays where it is: `where id=$1 and lease_id=$2 and
 * state='running' and not cancel_requested and heartbeat fresh`); the one
 * statement here is the cheap read the model proxy makes per request.
 * `scope` opens the request's database scope (withDatabaseScope) around each
 * call, as the Claude Code routes do.
 */
export function createTurnBoxEdgeOps(
	scope: <T>(run: () => Promise<T>) => Promise<T>,
	options: {
		readonly machines?: () => WorkspaceMachines;
		readonly claudePlacement?: (
			turn: ApiTurn,
			candidate: string,
		) => Promise<string>;
		/**
		 * Starts queued chat turns in their objects now (the admission the
		 * minute's sweep runs): a turn handed to its object does not wait for
		 * that sweep, up to a minute with the chat showing nothing.
		 */
		readonly admit?: () => Promise<void>;
		/** Tells the chat's object a box turn started or settled (its crew and hub notes). */
		readonly noteChat?: (
			turn: ApiTurn,
			turnStatus: SessionTurnStatus,
			items: readonly SessionItem[],
		) => Promise<unknown>;
	} = {},
): TurnBoxEdgeOps {
	const noteChat = (
		turn: ApiTurn,
		turnStatus: SessionTurnStatus,
		items: readonly SessionItem[],
	) =>
		options.noteChat
			? options.noteChat(turn, turnStatus, items).catch(() => {
					console.warn("The chat was not told of its box turn.", {
						turnStatus,
					});
				})
			: Promise.resolve();
	return {
		noteStarted: async (turn) => {
			await noteChat(turn, "running", turn.items ?? []);
		},
		boxActive: (boxId) => scope(() => turnRunnerBoxActive(boxId)),
		register: (boxId, input) =>
			scope(() => registerTurnRunnerBox({ id: boxId, ...input })),
		claim: (perUserLimit) =>
			scope(() => {
				const limits = modelConcurrencyLimits();
				return claimApiTurn(
					perUserLimit ?? limits.perUser,
					limits.fleet,
					"node",
				);
			}),
		handToObject: (turn) =>
			scope(async () => {
				const leaseId = turn.lease_id;
				if (!leaseId) return;
				// The box may hold the chat's coordination lease for this turn:
				// let it go, or the object refuses the turn as already running.
				// A hand-off, not a release: a released turn is retired for 70 s
				// and the object's acquire of it would be refused until then.
				await coordinateConversationTurn("handoff", {
					userId: turn.user_id,
					sessionId: turn.session_id,
					turnId: turn.id,
					leaseId,
				}).catch(() => {
					console.warn("Coordination release before a hand-off failed.");
				});
				if (!(await handClaimedApiTurnToObject(turn.id, leaseId))) return;
				await options.admit?.().catch(() => {
					console.warn(
						"A handed-over turn waits for the admission sweep; starting it now failed.",
					);
				});
			}),
		releaseClaim: (turnId, leaseId) =>
			scope(async () => {
				await releaseClaimedApiTurn(turnId, leaseId, "node");
			}),
		loadOwned: (grant) =>
			scope(async () => {
				const turn = await readRunningApiTurn(grant.turnId, grant.leaseId);
				return turn &&
					turn.lease_id === grant.leaseId &&
					turn.user_id === grant.userId &&
					turn.session_id === grant.sessionId
					? turn
					: null;
			}),
		loadOwnedIdentity: (grant) =>
			scope(async () => {
				const turn = await readRunningApiTurnIdentity(
					grant.turnId,
					grant.leaseId,
				);
				return turn &&
					turn.lease_id === grant.leaseId &&
					turn.user_id === grant.userId &&
					turn.session_id === grant.sessionId
					? turn
					: null;
			}),
		renew: (turn) => scope(() => renewApiTurn(turn)),
		checkpoint: (turn, input) =>
			scope(() =>
				checkpointApiTurn(turn, input.messages, input.items, input.failover),
			),
		progress: (turn, items) =>
			scope(async () => {
				await publishApiTurnProgress(turn, items);
			}),
		finalize: (turn, input) =>
			scope(async () => {
				const saved = await finalizeApiTurn(
					turn,
					input.state,
					input.items,
					input.messages,
				);
				// What the chat's own loop tells Y² and the open tabs when a turn ends.
				if (saved)
					await noteChat(turn, settledHubTurnStatus(saved), input.items);
				// What the Durable Object's turn does after it is settled and needs
				// the account key (the push, the queued message): the edge does it.
				const machines = options.machines;
				if (
					machines &&
					(saved === "completed" || (saved === "cancelled" && input.publish))
				)
					await afterBoxTurnSettled(
						turn,
						{
							state: saved,
							items: input.items,
							publish: input.publish === true,
						},
						{ machines },
					);
				return saved;
			}),
		cancelRequested: (turn) => scope(() => apiTurnCancelRequested(turn)),
		reserve: (grant, tokens) =>
			scope(async () => {
				try {
					await reserveApiTokens(grant.userId, grant.sessionId, tokens);
					return { ok: true };
				} catch (error) {
					return {
						ok: false,
						message:
							error instanceof Error ? error.message.slice(0, 300) : "refused",
					};
				}
			}),
		authorizeModel: (grant) => scope(() => authorizeTurnBoxModel(grant, scope)),
		port: (turn, op, args) =>
			scope(() =>
				turnBoxPort(turn, op, args as BoxPortArgs<typeof op>, {
					machines: options.machines,
					...(options.claudePlacement
						? { claudePlacement: options.claudePlacement }
						: {}),
				}),
			),
	};
}

/**
 * The turn's own connection while the turn is running under the grant's
 * lease: an API key (decrypted here), a Codex subscription (a turn with no
 * connection and the subscription revision) or a Grok subscription
 * connection. The subscription kinds get a `send` that carries the OAuth
 * tokens, which stay in this process (docs/turn-runner-boxes.md,
 * "Subscription routes"). Claude Code turns never reach the proxy. `scope`
 * opens the database scope again for `send`, which runs after this
 * request's own scope has closed.
 */
export async function authorizeTurnBoxModel(
	grant: TurnBoxGrant,
	scope: <T>(run: () => Promise<T>) => Promise<T> = (run) => run(),
): Promise<TurnBoxModelAuthorization> {
	const turnRow = (
		await database().query<{
			connection_id: string | null;
			connection_revision: string;
			failover: unknown;
		}>(
			`select connection_id, connection_revision, failover from api_turn where id=$1 and lease_id=$2 and user_id=$3 and session_id=$4
			 and state='running' and not cancel_requested and ${apiTurnLeaseFreshSql()}`,
			[grant.turnId, grant.leaseId, grant.userId, grant.sessionId],
		)
	).rows[0];
	if (!turnRow) return { kind: "refused", status: 401 };
	// After a failover the turn runs on its fallback route (the box saved it
	// with its checkpoint), as in the Durable Object. Always one of this
	// user's own connections: loadModelConnection is scoped to the user.
	const switched = turnFailover(turnRow.failover)?.route;
	const row = switched
		? {
				connection_id: switched.connectionId,
				connection_revision: switched.connectionRevision,
			}
		: turnRow;
	if (!row.connection_id) {
		// The ChatGPT Codex plan: no connection row, a revision that says so.
		if (!subscriptionTurnSettings(row.connection_revision))
			return { kind: "refused", status: 403 };
		return {
			kind: "ok",
			connectionKind: "subscription",
			subscription: "codex",
			baseUrl: `${CODEX_BACKEND}/codex`,
			send: (url, init) =>
				scope(() =>
					subscriptionFetch(
						grant.userId,
						url.slice(CODEX_BACKEND.length + 1),
						init,
					),
				),
		};
	}
	const connection = await loadModelConnection(grant.userId, row.connection_id);
	if (!connection) return { kind: "refused", status: 403 };
	if (connection.subscription) {
		// SuperGrok: the OAuth bearer replaces the placeholder key, refreshed
		// once on a 401, exactly as the Durable Object's fetch does.
		if (
			connection.subscription.provider !== "xai" ||
			!isXaiDirectEndpoint(connection.baseUrl)
		)
			return { kind: "refused", status: 403 };
		const send = xaiSubscriptionFetch(grant.userId, connection.id, fetch);
		return {
			kind: "ok",
			connectionKind: "subscription",
			subscription: "xai",
			baseUrl: connection.baseUrl,
			send: (url, init) => scope(() => send(url, init)),
		};
	}
	return {
		kind: "ok",
		connectionKind: "key",
		provider: connection.provider,
		baseUrl: connection.baseUrl,
		apiKey: await connectionApiKey(grant.userId, connection),
	};
}
