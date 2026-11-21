import type { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import type { completedLifecycleContinuations } from "../adapters/agent-task-command-receipts";
import type {
	releaseHeldAgentTaskEvents,
	saveAgentTaskResultAndEvent,
} from "../adapters/agent-task-events";
import type { captureServerAnalytics } from "../adapters/analytics";
import type {
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
import type { reserveApiTokens } from "../adapters/api-usage-budget";
import type { pinnedClaudeRunner } from "../adapters/claude-runner-placement";
import type { claudeSubscriptionStatus } from "../adapters/claude-subscription";
import type { warmCodexSubscriptionCatalog } from "../adapters/codex-subscription";
import type { archiveModelContext } from "../adapters/context-archives";
import type { conversationPointCodeRef } from "../adapters/conversation-recovery";
import type { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import type {
	harnessVariantForUser,
	isDevEvalUser,
} from "../adapters/dev-eval-users";
import type { gitPushRequests } from "../adapters/git-push-requests";
import type {
	assertEvaluationActive,
	evaluationRunForTask,
	recordEvaluationUsage,
	reserveEvaluationRequest,
} from "../adapters/harness-evaluation";
import type { projectImportedSessions } from "../adapters/local-imports";
import type { connectableMcpServers } from "../adapters/mcp-servers";
import type { loadModelConnection } from "../adapters/model-connections";
import type {
	enabledPluginSkillIndex,
	pluginSkillBody,
} from "../adapters/plugin-installs";
import type {
	readPreparedCheckoutDirectory,
	readProjectDerivedValue,
	readSessionDerivedValue,
	savePreparedCheckoutDirectory,
	saveSessionDerivedValue,
} from "../adapters/prepared-checkout";
import type { injectServerPeerMessages } from "../adapters/server-peer-inbox";
import type { subagentAncestors } from "../adapters/subagents";
import type { readVerificationBaseline } from "../adapters/turn-verification";
import type { noteUserHub } from "../adapters/user-hub-notes";
import type { projectYMode } from "../adapters/y-mode";
import type { noteCrewWaiting } from "../adapters/y-squared-crew-client";
import type { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import type { ApiModelAccess } from "../services/api-agent-runtime";
import type { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import type { ensureConversationCodePoint } from "../services/conversation-recovery";
import type { McpConnection } from "../services/mcp-tools";
import type { recordCloudProjectReport } from "../services/project-knowledge";
import type {
	loadAgentProjectSecrets,
	saveAccountWideSecret,
	saveVisibleProjectSecret,
	setSecretDescription,
	writeAgentProjectSecrets,
} from "../services/project-secrets";
import type { withPushResultNotices } from "../services/push-approval";
import type { startQueuedUserTurn } from "../services/queued-user-messages";
import type { SubagentToolDeps } from "../services/subagent-tools";
import type { commitSessionTurn } from "../services/turn-commit";
import type { subagentMemory, turnMemory } from "../services/turn-memory";
import type { enqueueAgentTaskEvent } from "./queue";

/**
 * Everything `runApiTurn` persists or reads through a database-backed
 * module, as one explicit object (docs/turn-runner-boxes.md, "Turn ports").
 * Two implementations:
 *
 * - `localTurnPorts` (turn-ports-local.ts): the modules themselves, for the
 *   chat's Durable Object. Behaviour is exactly what runApiTurn did when it
 *   imported them.
 * - `boxTurnPorts` (turn-box-ports.ts): the edge's thin-client API, for a
 *   turn runner box that holds no database URL, provider key or vault key.
 *
 * Each member has the type of the function it replaces, so call sites did
 * not change. This file imports types only, so a box can load it without
 * loading a database adapter.
 */
export interface TurnPorts {
	// The turn row: lease, saved progress, stop.
	readonly renewApiTurn: typeof renewApiTurn;
	readonly checkpointApiTurn: typeof checkpointApiTurn;
	readonly publishApiTurnProgress: typeof publishApiTurnProgress;
	readonly finalizeApiTurn: typeof finalizeApiTurn;
	readonly apiTurnCancelRequested: typeof apiTurnCancelRequested;
	readonly reserveApiTokens: typeof reserveApiTokens;
	readonly replaceSettledTurnItem: typeof replaceSettledTurnItem;
	readonly otherRunningTurnOnMachine: typeof otherRunningTurnOnMachine;
	readonly turnBoxToolIdentity: typeof turnBoxToolIdentity;
	readonly recordTurnBoxToolIdentity: typeof recordTurnBoxToolIdentity;
	readonly clearTurnBoxToolIdentity: typeof clearTurnBoxToolIdentity;
	readonly coordinateConversationTurn: typeof coordinateConversationTurn;

	// Session, project and user reads.
	readonly agentSessionMetadataForOwner: typeof agentSessionMetadataForOwner;
	readonly subagentAncestors: typeof subagentAncestors;
	readonly projectImportedSessions: typeof projectImportedSessions;
	readonly projectYMode: typeof projectYMode;
	readonly loadModelConnection: typeof loadModelConnection;
	readonly completedLifecycleContinuations: typeof completedLifecycleContinuations;
	readonly conversationPointCodeRef: typeof conversationPointCodeRef;
	readonly readVerificationBaseline: typeof readVerificationBaseline;
	readonly readPreparedCheckoutDirectory: typeof readPreparedCheckoutDirectory;
	readonly savePreparedCheckoutDirectory: typeof savePreparedCheckoutDirectory;
	readonly readProjectDerivedValue: typeof readProjectDerivedValue;
	readonly readSessionDerivedValue: typeof readSessionDerivedValue;
	readonly saveSessionDerivedValue: typeof saveSessionDerivedValue;
	readonly enabledPluginSkillIndex: typeof enabledPluginSkillIndex;
	readonly pluginSkillBody: typeof pluginSkillBody;
	readonly harnessVariantForUser: typeof harnessVariantForUser;
	readonly isDevEvalUser: typeof isDevEvalUser;
	readonly connectableMcpServers: typeof connectableMcpServers;

	// Events, relays and usage.
	readonly saveAgentTaskResultAndEvent: typeof saveAgentTaskResultAndEvent;
	readonly releaseHeldAgentTaskEvents: typeof releaseHeldAgentTaskEvents;
	readonly enqueueAgentTaskEvent: typeof enqueueAgentTaskEvent;
	readonly captureServerAnalytics: typeof captureServerAnalytics;
	readonly noteUserHub: typeof noteUserHub;
	readonly noteCrewWaiting: typeof noteCrewWaiting;
	readonly injectServerPeerMessages: typeof injectServerPeerMessages;
	readonly archiveModelContext: typeof archiveModelContext;
	readonly recordCloudProjectReport: typeof recordCloudProjectReport;

	// Harness evaluation runs (they stay in Durable Objects).
	readonly evaluationRunForTask: typeof evaluationRunForTask;
	readonly assertEvaluationActive: typeof assertEvaluationActive;
	readonly recordEvaluationUsage: typeof recordEvaluationUsage;
	readonly reserveEvaluationRequest: typeof reserveEvaluationRequest;

	// Subscription routes (Claude Code, Codex): never run on a box.
	readonly pinnedClaudeRunner: typeof pinnedClaudeRunner;
	readonly claudeSubscriptionStatus: typeof claudeSubscriptionStatus;
	readonly warmCodexSubscriptionCatalog: typeof warmCodexSubscriptionCatalog;
	readonly hasManagedCodexAuth: typeof hasManagedCodexAuth;

	/**
	 * Set on a box: how the model is reached (the edge's proxy with the turn's
	 * current grant). Unset in the Durable Object, which holds the key.
	 */
	readonly modelAccess?: ApiModelAccess;

	// Services whose work is database or vault backed plus the workspace.
	readonly gitPushRequests: typeof gitPushRequests;
	readonly loadAgentProjectSecrets: typeof loadAgentProjectSecrets;
	readonly saveAccountWideSecret: typeof saveAccountWideSecret;
	readonly saveVisibleProjectSecret: typeof saveVisibleProjectSecret;
	readonly setSecretDescription: typeof setSecretDescription;
	readonly writeAgentProjectSecrets: typeof writeAgentProjectSecrets;
	readonly startQueuedUserTurn: typeof startQueuedUserTurn;
	readonly commitSessionTurn: typeof commitSessionTurn;
	readonly ensureConversationCodePoint: typeof ensureConversationCodePoint;

	/**
	 * The turn's workspace preparation (bind the chat's machine, check out the
	 * repository, baselines). A box does not prepare it: the edge's
	 * `vm/ensure` already did (turn-box-vm-edge.ts `prepare`).
	 */
	readonly deferredApiTurnWorkspace: typeof deferredApiTurnWorkspace;
	/** Cross-chat memory (reads the database, clones a repo onto the VM). Off on a box (documented decision). */
	readonly turnMemory: typeof turnMemory;
	readonly subagentMemory: typeof subagentMemory;
	/** Notices for push cards answered meanwhile (reads the push request table). */
	readonly withPushResultNotices: typeof withPushResultNotices;
	/**
	 * Set on a box: the agent tools' database and helper-VM operations, served
	 * by the edge (turn-box-subagent-port.ts). Unset in the Durable Object,
	 * where the tools call them directly.
	 */
	readonly subagentToolDeps?: Partial<SubagentToolDeps>;
	/**
	 * Set on a box: the turn's MCP tools, listed and called by the edge
	 * (turn-box-mcp-port.ts), so no server credential reaches the box. Unset
	 * in the Durable Object, which connects to the servers itself.
	 */
	readonly mcpTools?: (signal: AbortSignal) => Promise<McpConnection>;
	/**
	 * Set on a box: runs one of the tools whose work needs a secret value or a
	 * record the box must not hold (save/describe a secret, push approval) on
	 * the edge (turn-box-tool-port.ts). Unset in the Durable Object.
	 */
	/** Set on a box: a canvas's highest saved revision, read by the edge (canvas-revisions.ts). */
	readonly savedCanvasRevision?: (title: string) => Promise<number>;
	readonly remoteTool?: (
		name: string,
		input: unknown,
		cwd?: string,
	) => Promise<unknown>;
}

export type TurnPortName = keyof TurnPorts;

/** A port the box has no edge endpoint for yet (docs/turn-runner-boxes.md). */
export class TurnPortUnavailable extends Error {
	constructor(readonly port: string) {
		super(
			`${port} is not available on a turn runner box (no edge endpoint yet).`,
		);
		this.name = "TurnPortUnavailable";
	}
}
