import { Effect } from "effect";
import {
	AGENT_ORCHESTRATION_INSTRUCTIONS,
	agentSessionRoleInstructions,
} from "#/domain/agent-orchestration";
import { assertApiContextFits } from "#/domain/api-conversation";
import { applyApiProgress } from "#/domain/api-progress";
import {
	type ApiTurnFailureStage,
	apiTurnFailureMessage,
} from "#/domain/api-turn-failure";
import { PREPARED_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
import {
	type ApiTurn,
	checkpointApiTurn,
	finishApiTurn,
	renewApiTurn,
} from "../adapters/api-turns";
import { reserveApiTokens } from "../adapters/api-usage-budget";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import { loadModelConnection } from "../adapters/model-connections";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { bindAgentSessionMachine } from "../services/agent-session-machine";
import { runApiAgent } from "../services/api-agent-runtime";
import { apiAgentTools } from "../services/api-agent-tools";
import { runCodexSubscriptionAgent } from "../services/codex-subscription-agent";
import { injectApiPeerMessages } from "../services/peer-inbox";
import {
	ensureProjectCheckout,
	loadTenantProjectCheckout,
} from "../services/project-workspace";
import { machinesForAgentSession } from "../services/session-workspace-machines";
import type { WorkspaceMachines } from "../services/workspace-machines";

export async function runApiTurn(machines: WorkspaceMachines, turn: ApiTurn) {
	const abort = new AbortController();
	let items = turn.items;
	let messages = turn.messages;
	let publishProgress:
		| ((status: "running" | "completed" | "failed" | "idle") => Promise<void>)
		| undefined;
	let heartbeatBusy = false;
	let failureStage: ApiTurnFailureStage = "connection";
	const heartbeat = setInterval(() => {
		if (heartbeatBusy) return;
		heartbeatBusy = true;
		void renewApiTurn(turn)
			.then((alive) => {
				if (!alive) abort.abort();
			})
			.catch(() => abort.abort())
			.finally(() => {
				heartbeatBusy = false;
			});
	}, 1000);
	try {
		if (!(await renewApiTurn(turn))) {
			abort.abort();
			abort.signal.throwIfAborted();
		}
		const owner = await agentSessionForOwner(turn.user_id, turn.session_id);
		if (!owner) throw new Error("Task no longer exists.");
		const subscription = subscriptionTurnSettings(turn.connection_revision);
		if (subscription) {
			if (turn.connection_id || !(await hasManagedCodexAuth(turn.user_id)))
				throw new Error("Reconnect Codex before continuing.");
		} else {
			if (!turn.connection_id) throw new Error("Model connection was removed.");
			const connection = await loadModelConnection(
				turn.user_id,
				turn.connection_id,
			);
			if (connection?.revision !== turn.connection_revision)
				throw new Error(
					"The API connection changed after this turn was submitted.",
				);
		}
		failureStage = "workspace";
		const bound = await bindAgentSessionMachine(machines, {
			userId: owner.userId,
			projectId: owner.projectId,
			sessionId: owner.id,
			harness: subscription ? "codex" : "api",
		});
		machines = machinesForAgentSession(machines, bound.session);
		await machines.ensureRunning(WorkspaceId(bound.providerRef));
		if (bound.session.taskPlacement !== "shared") {
			await Effect.runPromise(
				Effect.gen(function* () {
					const checkout = yield* loadTenantProjectCheckout({
						userId: owner.userId,
						projectId: owner.projectId,
						sessionId: owner.id,
					});
					yield* ensureProjectCheckout(
						machines,
						WorkspaceId(bound.providerRef),
						checkout,
					);
				}),
			);
		}
		publishProgress = (turnStatus) =>
			machines.writeTextFile(
				WorkspaceId(bound.providerRef),
				"/tmp/ytimesy-api-progress.json",
				JSON.stringify({
					sessionId: owner.id,
					turnId: turn.id,
					items,
					turnStatus,
				}),
			);
		await publishProgress("running");
		const cwd = (
			await machines.readTextFile(
				WorkspaceId(bound.providerRef),
				PROJECT_CWD_PATH,
			)
		)?.trim();
		if (!cwd?.startsWith("/"))
			throw new Error("Prepared repository path is unavailable.");
		const tools = apiAgentTools({
			machines,
			session: bound.session,
			cwd,
			turnId: turn.id,
			signal: abort.signal,
		});
		let flushedAt = 0;
		failureStage = "model";
		const runAgent = subscription
			? runCodexSubscriptionAgent
			: (input: Parameters<typeof runCodexSubscriptionAgent>[0]) =>
					runApiAgent({ ...input, connectionId: turn.connection_id as string });
		await runAgent({
			cacheScopeId: owner.id,
			userId: turn.user_id,
			connectionId: turn.connection_id ?? undefined,
			connectionRevision: turn.connection_revision,
			reasoning: subscription?.reasoning,
			fast: subscription?.fast,
			modelId: turn.model_id,
			messages,
			instructions: `You are the ytimesy coding agent. Work in ${cwd}. Read repository instructions before editing. ${PREPARED_ENVIRONMENT_INSTRUCTIONS} ${AGENT_ORCHESTRATION_INSTRUCTIONS} ${agentSessionRoleInstructions(bound.session)}`,
			tools,
			signal: abort.signal,
			prepareMessages: (history) =>
				injectApiPeerMessages(
					machines,
					WorkspaceId(bound.providerRef),
					history,
					async (injected) => {
						messages = injected;
						await checkpointApiTurn(turn, messages, items);
					},
					owner.id,
				),
			beforeStep: async (history) => {
				failureStage = "budget";
				assertApiContextFits(history);
				abort.signal.throwIfAborted();
				if (!subscription)
					await reserveApiTokens(
						owner.userId,
						owner.id,
						Buffer.byteLength(JSON.stringify(history), "utf8") + 24_000,
					);
				failureStage = "model";
			},
			beforeCompaction: async (older) => {
				failureStage = "budget";
				if (!subscription)
					await reserveApiTokens(
						owner.userId,
						owner.id,
						Buffer.byteLength(JSON.stringify(older), "utf8") + 4_000,
					);
				failureStage = "model";
			},
			onEvent: async (event) => {
				items = applyApiProgress(items, turn.id, event);
				if (Date.now() - flushedAt >= 250 || event.type === "finish") {
					failureStage = "workspace";
					await publishProgress?.("running");
					failureStage = "model";
					flushedAt = Date.now();
				}
			},
			onStep: async (history) => {
				failureStage = "saving";
				messages = history;
				await checkpointApiTurn(turn, messages, items);
				failureStage = "model";
			},
		});
		failureStage = "saving";
		const saved = await finishApiTurn(turn, "completed", items);
		if (!saved) return;
		await publishProgress("completed").catch(() => {});
		if (owner.parentSessionId)
			await saveAgentTaskResultAndEvent({
				sessionId: owner.id,
				eventType: "completed",
				summary:
					items
						.filter((item) => item.kind === "agentMessage")
						.map((item) => item.text)
						.join("\n")
						.slice(-16000) || "Task completed.",
			});
	} catch (error) {
		items = [
			...items,
			{
				kind: "error",
				id: SessionItemId(`${turn.id}:error`),
				message: abort.signal.aborted
					? "Run stopped. Inspect any in-flight command before continuing."
					: apiTurnFailureMessage(failureStage, error),
			},
		];
		items = applyApiProgress(items, turn.id, {
			type: "finish",
			inputTokens: null,
			outputTokens: null,
			reason: "error",
		});
		const saved = await finishApiTurn(
			turn,
			abort.signal.aborted ? "cancelled" : "failed",
			items,
		);
		if (saved)
			await publishProgress?.(abort.signal.aborted ? "idle" : "failed").catch(
				() => {},
			);
	} finally {
		clearInterval(heartbeat);
	}
}
