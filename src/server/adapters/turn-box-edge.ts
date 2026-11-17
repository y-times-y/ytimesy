import type { TurnBoxGrant } from "#/domain/turn-box-grant";
import type { TurnBoxModelAuthorization } from "#/domain/turn-box-model-proxy";
import type { BoxPortArgs } from "#/domain/turn-box-protocol";
import type { TurnBoxEdgeOps } from "../edge/turn-box-routes";
import { connectionApiKey } from "../services/model-connections";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { modelConcurrencyLimits } from "./agent-capacity";
import {
	apiTurnCancelRequested,
	apiTurnLeaseFreshSql,
	checkpointApiTurn,
	claimApiTurn,
	finalizeApiTurn,
	publishApiTurnProgress,
	readRunningApiTurn,
	releaseClaimedApiTurn,
	renewApiTurn,
} from "./api-turns";
import { reserveApiTokens } from "./api-usage-budget";
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
	options: { readonly machines?: () => WorkspaceMachines } = {},
): TurnBoxEdgeOps {
	return {
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
		authorizeModel: (grant) => scope(() => authorizeTurnBoxModel(grant)),
		port: (turn, op, args) =>
			scope(() =>
				turnBoxPort(turn, op, args as BoxPortArgs<typeof op>, {
					machines: options.machines,
				}),
			),
	};
}

/**
 * The turn's own API-key connection and its decrypted key, while the turn is
 * running under the grant's lease. Turns with no connection (Codex and
 * Claude subscriptions) and subscription-kind connections are refused: the
 * proxy serves API keys only.
 */
export async function authorizeTurnBoxModel(
	grant: TurnBoxGrant,
): Promise<TurnBoxModelAuthorization> {
	const row = (
		await database().query<{ connection_id: string | null }>(
			`select connection_id from api_turn where id=$1 and lease_id=$2 and user_id=$3 and session_id=$4
			 and state='running' and not cancel_requested and ${apiTurnLeaseFreshSql()}`,
			[grant.turnId, grant.leaseId, grant.userId, grant.sessionId],
		)
	).rows[0];
	if (!row) return { kind: "refused", status: 401 };
	if (!row.connection_id) return { kind: "refused", status: 403 };
	const connection = await loadModelConnection(grant.userId, row.connection_id);
	if (!connection || connection.subscription)
		return { kind: "refused", status: 403 };
	return {
		kind: "ok",
		connectionKind: "key",
		provider: connection.provider,
		baseUrl: connection.baseUrl,
		apiKey: await connectionApiKey(grant.userId, connection),
	};
}
