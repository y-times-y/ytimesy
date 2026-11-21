import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { completedLifecycleContinuations } from "../adapters/agent-task-command-receipts";
import {
	releaseHeldAgentTaskEvents,
	saveAgentTaskResultAndEvent,
} from "../adapters/agent-task-events";
import { captureServerAnalytics } from "../adapters/analytics";
import {
	apiTurnCancelRequested,
	checkpointApiTurn,
	clearTurnBoxToolIdentity,
	finalizeApiTurn,
	otherRunningTurnOnMachine,
	publishApiTurnProgress,
	recordTurnBoxToolIdentity,
	renewApiTurn,
	replaceSettledTurnItem,
	turnBoxToolIdentity,
} from "../adapters/api-turns";
import { reserveApiTokens } from "../adapters/api-usage-budget";
import { pinnedClaudeRunner } from "../adapters/claude-runner-placement";
import { claudeSubscriptionStatus } from "../adapters/claude-subscription";
import { warmCodexSubscriptionCatalog } from "../adapters/codex-subscription";
import { archiveModelContext } from "../adapters/context-archives";
import { conversationPointCodeRef } from "../adapters/conversation-recovery";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import {
	harnessVariantForUser,
	isDevEvalUser,
} from "../adapters/dev-eval-users";
import { gitPushRequests } from "../adapters/git-push-requests";
import {
	assertEvaluationActive,
	evaluationRunForTask,
	recordEvaluationUsage,
	reserveEvaluationRequest,
} from "../adapters/harness-evaluation";
import { projectImportedSessions } from "../adapters/local-imports";
import { connectableMcpServers } from "../adapters/mcp-servers";
import { loadModelConnection } from "../adapters/model-connections";
import {
	enabledPluginSkillIndex,
	pluginSkillBody,
} from "../adapters/plugin-installs";
import {
	readPreparedCheckoutDirectory,
	readProjectDerivedValue,
	readSessionDerivedValue,
	savePreparedCheckoutDirectory,
	saveSessionDerivedValue,
} from "../adapters/prepared-checkout";
import { injectServerPeerMessages } from "../adapters/server-peer-inbox";
import { subagentAncestors } from "../adapters/subagents";
import { readVerificationBaseline } from "../adapters/turn-verification";
import { noteUserHub } from "../adapters/user-hub-notes";
import { projectYMode } from "../adapters/y-mode";
import { noteCrewWaiting } from "../adapters/y-squared-crew-client";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import { ensureConversationCodePoint } from "../services/conversation-recovery";
import { recordCloudProjectReport } from "../services/project-knowledge";
import {
	loadAgentProjectSecrets,
	saveAccountWideSecret,
	saveVisibleProjectSecret,
	setSecretDescription,
	writeAgentProjectSecrets,
} from "../services/project-secrets";
import { withPushResultNotices } from "../services/push-approval";
import { startQueuedUserTurn } from "../services/queued-user-messages";
import { commitSessionTurn } from "../services/turn-commit";
import { subagentMemory, turnMemory } from "../services/turn-memory";
import { enqueueAgentTaskEvent } from "./queue";
import type { TurnPorts } from "./turn-ports";

/**
 * The Durable Object's ports: the database-backed modules themselves.
 * Every member looks its function up when it is called (not when the object
 * is built), so a caller sees the module exactly as the direct import did,
 * including a test's module mock.
 */
const lazy = <T extends (...args: never[]) => unknown>(get: () => T): T =>
	((...args: unknown[]) =>
		(get() as unknown as (...inner: unknown[]) => unknown)(
			...args,
		)) as unknown as T;

export const localTurnPorts: TurnPorts = {
	renewApiTurn: lazy(() => renewApiTurn),
	checkpointApiTurn: lazy(() => checkpointApiTurn),
	publishApiTurnProgress: lazy(() => publishApiTurnProgress),
	finalizeApiTurn: lazy(() => finalizeApiTurn),
	apiTurnCancelRequested: lazy(() => apiTurnCancelRequested),
	reserveApiTokens: lazy(() => reserveApiTokens),
	replaceSettledTurnItem: lazy(() => replaceSettledTurnItem),
	otherRunningTurnOnMachine: lazy(() => otherRunningTurnOnMachine),
	turnBoxToolIdentity: lazy(() => turnBoxToolIdentity),
	recordTurnBoxToolIdentity: lazy(() => recordTurnBoxToolIdentity),
	clearTurnBoxToolIdentity: lazy(() => clearTurnBoxToolIdentity),
	coordinateConversationTurn: lazy(() => coordinateConversationTurn),
	agentSessionMetadataForOwner: lazy(() => agentSessionMetadataForOwner),
	subagentAncestors: lazy(() => subagentAncestors),
	projectImportedSessions: lazy(() => projectImportedSessions),
	projectYMode: lazy(() => projectYMode),
	loadModelConnection: lazy(() => loadModelConnection),
	completedLifecycleContinuations: lazy(() => completedLifecycleContinuations),
	conversationPointCodeRef: lazy(() => conversationPointCodeRef),
	readVerificationBaseline: lazy(() => readVerificationBaseline),
	readPreparedCheckoutDirectory: lazy(() => readPreparedCheckoutDirectory),
	savePreparedCheckoutDirectory: lazy(() => savePreparedCheckoutDirectory),
	readProjectDerivedValue: lazy(() => readProjectDerivedValue),
	readSessionDerivedValue: lazy(() => readSessionDerivedValue),
	saveSessionDerivedValue: lazy(() => saveSessionDerivedValue),
	enabledPluginSkillIndex: lazy(() => enabledPluginSkillIndex),
	pluginSkillBody: lazy(() => pluginSkillBody),
	harnessVariantForUser: lazy(() => harnessVariantForUser),
	isDevEvalUser: lazy(() => isDevEvalUser),
	connectableMcpServers: lazy(() => connectableMcpServers),
	saveAgentTaskResultAndEvent: lazy(() => saveAgentTaskResultAndEvent),
	releaseHeldAgentTaskEvents: lazy(() => releaseHeldAgentTaskEvents),
	enqueueAgentTaskEvent: lazy(() => enqueueAgentTaskEvent),
	captureServerAnalytics: lazy(() => captureServerAnalytics),
	noteUserHub: lazy(() => noteUserHub),
	noteCrewWaiting: lazy(() => noteCrewWaiting),
	injectServerPeerMessages: lazy(() => injectServerPeerMessages),
	archiveModelContext: lazy(() => archiveModelContext),
	recordCloudProjectReport: lazy(() => recordCloudProjectReport),
	evaluationRunForTask: lazy(() => evaluationRunForTask),
	assertEvaluationActive: lazy(() => assertEvaluationActive),
	recordEvaluationUsage: lazy(() => recordEvaluationUsage),
	reserveEvaluationRequest: lazy(() => reserveEvaluationRequest),
	pinnedClaudeRunner: lazy(() => pinnedClaudeRunner),
	claudeSubscriptionStatus: lazy(() => claudeSubscriptionStatus),
	warmCodexSubscriptionCatalog: lazy(() => warmCodexSubscriptionCatalog),
	hasManagedCodexAuth: lazy(() => hasManagedCodexAuth),
	get gitPushRequests() {
		return gitPushRequests;
	},
	loadAgentProjectSecrets: lazy(() => loadAgentProjectSecrets),
	saveAccountWideSecret: lazy(() => saveAccountWideSecret),
	saveVisibleProjectSecret: lazy(() => saveVisibleProjectSecret),
	setSecretDescription: lazy(() => setSecretDescription),
	writeAgentProjectSecrets: lazy(() => writeAgentProjectSecrets),
	startQueuedUserTurn: lazy(() => startQueuedUserTurn),
	commitSessionTurn: lazy(() => commitSessionTurn),
	ensureConversationCodePoint: lazy(() => ensureConversationCodePoint),
	deferredApiTurnWorkspace: lazy(() => deferredApiTurnWorkspace),
	turnMemory: lazy(() => turnMemory),
	subagentMemory: lazy(() => subagentMemory),
	withPushResultNotices: lazy(() => withPushResultNotices),
	// The agent tools call their own database functions here.
	subagentToolDeps: undefined,
	// The loop connects to the user's MCP servers itself.
	mcpTools: undefined,
	// The tools run here, with the database and the secret values.
	remoteTool: undefined,
	savedCanvasRevision: undefined,
};
