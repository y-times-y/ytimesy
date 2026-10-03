import {
	AGENT_ORCHESTRATION_INSTRUCTIONS,
	agentSessionRoleInstructions,
} from "#/domain/agent-orchestration";
import { assertApiContextFits } from "#/domain/api-conversation";
import { applyApiProgress } from "#/domain/api-progress";
import {
	type ApiTurnFailureStage,
	apiTurnFailureMessage,
	IncompleteAgentTurn,
} from "#/domain/api-turn-failure";
import { PREPARED_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import { SessionItemId } from "#/domain/ids";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { withDelegationContext } from "../adapters/agent-delegation-context";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
import {
	type ApiTurn,
	checkpointApiTurn,
	finalizeApiTurn,
	publishApiTurnProgress,
	renewApiTurn,
} from "../adapters/api-turns";
import { reserveApiTokens } from "../adapters/api-usage-budget";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import { loadModelConnection } from "../adapters/model-connections";
import { injectServerPeerMessages } from "../adapters/server-peer-inbox";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import type { AgentToolWorkspace } from "../services/agent-tool-workspace";
import { runApiAgent } from "../services/api-agent-runtime";
import { apiAgentTools } from "../services/api-agent-tools";
import { stopApiTurnCommands } from "../services/api-command-scope";
import { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import { runCodexSubscriptionAgent } from "../services/codex-subscription-agent";
import { machinesForAgentSession } from "../services/session-workspace-machines";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { enqueueAgentTaskEvent } from "./queue";

export async function runApiTurn(machines: WorkspaceMachines, turn: ApiTurn) {
	const abort = new AbortController();
	let items = turn.items;
	let messages = turn.messages;
	let execution: AgentToolWorkspace | undefined;
	let commandStop: Promise<void> | undefined;
	const stopCommands = () => {
		if (execution)
			commandStop ??= stopApiTurnCommands(execution, turn.id).catch(() => {
				console.warn(
					"Command cancellation needs recovery; turn fencing remains active.",
				);
			});
	};
	abort.signal.addEventListener("abort", stopCommands, { once: true });
	let publishProgress:
		| ((status: "running" | "completed" | "failed" | "idle") => Promise<void>)
		| undefined;
	let heartbeatBusy = false;
	let failureStage: ApiTurnFailureStage = "connection";
	const control = {
		userId: turn.user_id,
		sessionId: turn.session_id,
		turnId: turn.id,
		leaseId: turn.lease_id as string,
	};
	let coordinated = false;
	let lastCoordinationRenewal = 0;
	const heartbeat = setInterval(() => {
		if (heartbeatBusy) return;
		heartbeatBusy = true;
		void renewApiTurn(turn)
			.then(async (alive) => {
				if (!alive) abort.abort();
				if (
					alive &&
					coordinated &&
					Date.now() - lastCoordinationRenewal >= 10_000
				) {
					if (!(await coordinateConversationTurn("renew", control)))
						abort.abort();
					lastCoordinationRenewal = Date.now();
				}
			})
			.catch(() => abort.abort())
			.finally(() => {
				heartbeatBusy = false;
			});
	}, 1000);
	try {
		if (
			!turn.lease_id ||
			!(await coordinateConversationTurn("acquire", control))
		)
			throw new Error("The conversation is already running or was stopped.");
		coordinated = true;
		lastCoordinationRenewal = Date.now();
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
		const prepareWorkspace = deferredApiTurnWorkspace(
			machines,
			owner,
			abort.signal,
		);
		const workspace = async () => {
			execution = await prepareWorkspace();
			return execution;
		};
		machines = machinesForAgentSession(machines, owner);
		publishProgress = async (turnStatus) => {
			if (turnStatus === "running") await publishApiTurnProgress(turn, items);
		};
		await publishProgress("running");
		const tools = apiAgentTools({
			machines,
			session: owner,
			workspace,
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
			instructions: `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository. Read repository instructions before editing. ${PREPARED_ENVIRONMENT_INSTRUCTIONS} ${AGENT_ORCHESTRATION_INSTRUCTIONS} ${agentSessionRoleInstructions(owner)}`,
			tools,
			signal: abort.signal,
			prepareMessages: async (history) => {
				const current = await withDelegationContext(
					owner.userId,
					owner.id,
					history,
				);
				return injectServerPeerMessages(owner.id, current, async (injected) => {
					messages = injected;
					await checkpointApiTurn(turn, messages, items);
				});
			},
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
					failureStage = "saving";
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
		abort.signal.throwIfAborted();
		let lastUser = items.length - 1;
		while (lastUser >= 0 && items[lastUser].kind !== "userMessage") lastUser--;
		if (
			!items
				.slice(lastUser + 1)
				.some((item) => item.kind === "agentMessage" && item.text.trim())
		)
			throw new IncompleteAgentTurn("missing-final-result");
		if (!(await coordinateConversationTurn("release", control)))
			throw new Error(
				"Conversation coordination lease was lost before completion.",
			);
		coordinated = false;
		const saved = await finalizeApiTurn(turn, "completed", items);
		if (saved !== "completed") {
			abort.abort();
			return;
		}
		await publishProgress("completed").catch(() => {});
		if (owner.parentSessionId) {
			const eventId = await saveAgentTaskResultAndEvent({
				sessionId: owner.id,
				turnId: turn.id,
				eventType: "completed",
				summary:
					items
						.slice(lastUser + 1)
						.filter((item) => item.kind === "agentMessage")
						.map((item) => item.text)
						.join("\n")
						.slice(-16000) ||
					"Turn ended without a recorded final summary; inspect the task before accepting it.",
			});
			if (eventId) await enqueueAgentTaskEvent(eventId).catch(() => {});
		}
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
		const saved = await finalizeApiTurn(
			turn,
			abort.signal.aborted ? "cancelled" : "failed",
			items,
		);
		if (saved)
			await publishProgress?.(saved === "cancelled" ? "idle" : "failed").catch(
				() => {},
			);
		if (saved === "failed") {
			const eventId = await saveAgentTaskResultAndEvent({
				sessionId: turn.session_id,
				turnId: turn.id,
				eventType: "failed",
				summary: apiTurnFailureMessage(failureStage, error),
			});
			if (eventId) await enqueueAgentTaskEvent(eventId).catch(() => {});
		}
		abort.abort();
	} finally {
		clearInterval(heartbeat);
		if (abort.signal.aborted) stopCommands();
		await commandStop;
		abort.signal.removeEventListener("abort", stopCommands);
		if (coordinated)
			await coordinateConversationTurn("release", control).catch(() => {});
	}
}
