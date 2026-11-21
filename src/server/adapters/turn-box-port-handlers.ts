import { WorkspaceId } from "#/domain/ids";
import type { BoxPortArgs, BoxPortOp } from "#/domain/turn-box-protocol";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import { subscriptionRefusalOf } from "#/domain/turn-box-subscription";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { ensureConversationCodePoint } from "../services/conversation-recovery";
import { recordCloudProjectReport } from "../services/project-knowledge";
import {
	loadAgentProjectSecrets,
	writeAgentProjectSecrets,
} from "../services/project-secrets";
import { commitSessionTurn } from "../services/turn-commit";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { agentSessionMetadataForOwner } from "./agent-sessions";
import { completedLifecycleContinuations } from "./agent-task-command-receipts";
import {
	releaseHeldAgentTaskEvents,
	saveAgentTaskResultAndEvent,
} from "./agent-task-events";
import { captureServerAnalytics } from "./analytics";
import { type ApiTurn, otherRunningTurnOnMachine } from "./api-turns";
import { codexSubscriptionSelection } from "./codex-subscription";
import { archiveModelContext } from "./context-archives";
import { conversationPointCodeRef } from "./conversation-recovery";
import { coordinateConversationTurn } from "./conversation-turn-control";
import { harnessVariantForUser, isDevEvalUser } from "./dev-eval-users";
import { projectImportedSessions } from "./local-imports";
import { loadModelConnection } from "./model-connections";
import { enabledPluginSkillIndex, pluginSkillBody } from "./plugin-installs";
import {
	readPreparedCheckoutDirectory,
	readProjectDerivedValue,
	readSessionDerivedValue,
	savePreparedCheckoutDirectory,
	saveSessionDerivedValue,
} from "./prepared-checkout";
import { acceptPeerInbox, readPeerInbox } from "./server-peer-inbox";
import { subagentAncestors } from "./subagents";
import { gitRuntimeOverMachines } from "./turn-box-edge-work";
import { readVerificationBaseline } from "./turn-verification";
import { noteUserHub } from "./user-hub-notes";
import { projectYMode } from "./y-mode";
import { noteCrewWaiting } from "./y-squared-crew-client";

/**
 * The edge's handlers for the turn ports a box calls
 * (`POST /box/v1/port`, turn-box-protocol.ts `boxPortArgs`). Each one only
 * composes an existing server function; there is no new SQL here. The user,
 * chat and turn come from the turn row the lease check loaded (so from the
 * grant), never from the arguments; an argument that names another chat or
 * project is refused (TurnBoxPortForbidden). Secrets stay on this side:
 * `modelConnection` drops the sealed credential and `projectSecretNames`
 * returns names and kinds only.
 */
export type TurnBoxPortDeps = {
	/** The edge's account-key machines (Freestyle); read only by the ops that act on the chat's VM. */
	readonly machines?: () => WorkspaceMachines;
};

export async function turnBoxPort<Op extends BoxPortOp>(
	turn: ApiTurn,
	op: Op,
	args: BoxPortArgs<Op>,
	deps: TurnBoxPortDeps = {},
): Promise<{ served: true; result: unknown } | { served: false }> {
	const result = await handle(turn, { op, args } as PortCall, deps);
	return result === NOT_SERVED ? { served: false } : { served: true, result };
}

type PortCall = {
	[K in BoxPortOp]: { op: K; args: BoxPortArgs<K> };
}[BoxPortOp];

const NOT_SERVED = Symbol("not-served");

/** The turn's chat, read once; a project argument must be this chat's project. */
async function ownMetadata(turn: ApiTurn) {
	const metadata = await agentSessionMetadataForOwner(
		turn.user_id,
		turn.session_id,
	);
	if (!metadata) throw new TurnBoxPortForbidden("session");
	return metadata;
}
async function ownProject(turn: ApiTurn, projectId: string, op: string) {
	const metadata = await ownMetadata(turn);
	if (metadata.projectId !== projectId) throw new TurnBoxPortForbidden(op);
	return metadata;
}

/** The edge's machines and the chat's own VM (from the chat, never from the box). */
async function ownVm(turn: ApiTurn, deps: TurnBoxPortDeps) {
	if (!deps.machines) throw new TurnBoxPortForbidden("no-machines");
	const owner = await ownMetadata(turn);
	if (!owner.providerRef) throw new TurnBoxPortForbidden("no-vm");
	return {
		owner,
		machines: deps.machines(),
		vm: WorkspaceId(owner.providerRef),
	};
}

async function handle(
	turn: ApiTurn,
	call: PortCall,
	deps: TurnBoxPortDeps,
): Promise<unknown> {
	const user = turn.user_id;
	const session = turn.session_id;
	switch (call.op) {
		case "sessionMetadata": {
			if (call.args.sessionId === session) return ownMetadata(turn);
			// The only other chat a turn reads is its parent (a side chat's main).
			const own = await ownMetadata(turn);
			if (own.parentSessionId !== call.args.sessionId)
				throw new TurnBoxPortForbidden(call.op);
			return agentSessionMetadataForOwner(user, call.args.sessionId);
		}
		case "sessionAncestors":
			return subagentAncestors(user, session);
		case "importedSessions":
			await ownProject(turn, call.args.projectId, call.op);
			return projectImportedSessions(user, call.args.projectId);
		case "projectYMode":
			await ownProject(turn, call.args.projectId, call.op);
			return projectYMode(user, call.args.projectId);
		case "modelConnection": {
			const connection = await loadModelConnection(user, call.args.id);
			if (!connection) return null;
			const { sealedCredential: _sealed, ...visible } = connection;
			return visible;
		}
		case "codexSelection":
			// A sign-in the provider rejected is the same typed failure the
			// Durable Object's own read would throw: it crosses as a code.
			return codexSubscriptionSelection(user, call.args).then(
				(selection) => ({ selection }),
				(error) => {
					const refused = subscriptionRefusalOf(error);
					if (!refused) throw error;
					return { refusal: { code: refused.code, body: refused.body } };
				},
			);
		case "codexAuth":
			return hasManagedCodexAuth(user);
		case "lifecycleContinuations":
			return completedLifecycleContinuations(session, turn.id);
		case "conversationPointCodeRef":
			return conversationPointCodeRef(user, session, call.args.messageId);
		case "verificationBaseline":
			return readVerificationBaseline(user, session, call.args.directory);
		case "preparedCheckoutDirectory":
			if (call.args.projectId !== null)
				await ownProject(turn, call.args.projectId, call.op);
			return readPreparedCheckoutDirectory(user, session, call.args.projectId);
		case "projectDerivedValue":
			await ownProject(turn, call.args.projectId, call.op);
			return readProjectDerivedValue(user, call.args.projectId, call.args.key);
		case "sessionDerivedValue":
			return readSessionDerivedValue(user, session, call.args.key);
		case "pluginSkillIndex":
			if (call.args.projectId !== null)
				await ownProject(turn, call.args.projectId, call.op);
			return enabledPluginSkillIndex(user, call.args.projectId);
		case "pluginSkillBody":
			return pluginSkillBody(user, call.args.installId, call.args.skill);
		case "harnessVariant":
			return harnessVariantForUser(user);
		case "isDevEvalUser":
			return isDevEvalUser(user);
		case "otherRunningTurnOnMachine":
			return otherRunningTurnOnMachine(user, turn.id, call.args.vm);
		case "projectSecretNames": {
			const metadata = await ownMetadata(turn);
			if (!metadata.projectId) return { names: [] };
			const { names } = await loadAgentProjectSecrets(user, metadata.projectId);
			return { names };
		}
		case "savePreparedCheckoutDirectory":
			return savePreparedCheckoutDirectory(user, session, call.args.directory);
		case "saveSessionDerivedValue":
			return saveSessionDerivedValue(
				user,
				session,
				call.args.key,
				call.args.value,
			);
		case "archiveContext":
			return archiveModelContext(user, session, call.args.messages);
		case "cloudProjectReport": {
			const metadata = await ownMetadata(turn);
			return recordCloudProjectReport(
				{ ...metadata, items: call.args.items },
				turn.id,
				call.args.items,
			);
		}
		case "saveTaskResult":
			return saveAgentTaskResultAndEvent({
				sessionId: session,
				summary: call.args.summary,
				turnId: turn.id,
				eventType: call.args.eventType,
			});
		case "releaseHeldTaskEvents":
			return releaseHeldAgentTaskEvents(session);
		case "enqueueTaskEvent":
			return (await import("../jobs/queue")).enqueueAgentTaskEvent(
				call.args.eventId,
			);
		case "analytics":
			await Promise.all(
				call.args.events.map((entry) =>
					captureServerAnalytics(user, entry.event, entry.properties as never, {
						key: entry.identity.key,
						timestamp: new Date(entry.identity.timestamp),
						setOnce: entry.identity.setOnce,
					}),
				),
			);
			return null;
		case "userHubNote":
			return noteUserHub(user, call.args.topics);
		case "crewWaiting":
			await ownProject(turn, call.args.projectId, call.op);
			return noteCrewWaiting({
				sessionId: session,
				userId: user,
				...call.args,
			});
		case "peerInboxRead":
			return readPeerInbox(session);
		case "peerInboxAccept":
			return acceptPeerInbox(session, call.args.ids);
		case "coordinateTurn":
			return coordinateConversationTurn(call.args.action, {
				userId: user,
				sessionId: session,
				turnId: turn.id,
				leaseId: turn.lease_id as string,
			});
		case "writeSecretsToVm": {
			const { owner, machines, vm } = await ownVm(turn, deps);
			const secrets = await loadAgentProjectSecrets(user, owner.projectId);
			await writeAgentProjectSecrets(machines, vm, secrets);
			return null;
		}
		case "commitTurn": {
			const { owner, machines } = await ownVm(turn, deps);
			const committed = await commitSessionTurn(
				{ ...owner, items: [] },
				call.args.items,
				gitRuntimeOverMachines(machines),
			);
			if (!committed) return null;
			return {
				...(committed.notice ? { notice: committed.notice } : {}),
				publish: Boolean(committed.publish),
			};
		}
		case "ensureCodePoint": {
			const { machines, vm } = await ownVm(turn, deps);
			await ensureConversationCodePoint(user, session, call.args.messageId, {
				machines,
				vm,
				cwd: call.args.cwd,
			});
			return null;
		}
		case "subagent":
			// Loaded on first use: the helper tools pull in the task services.
			return (await import("./turn-box-subagent-port")).subagentPort(
				turn,
				call.args.dep,
				call.args.args,
				{
					...(deps.machines ? { machines: deps.machines } : {}),
				},
			);
		case "memory":
			return (await import("./turn-box-memory-port")).memoryPort(
				turn,
				call.args,
				{ ...(deps.machines ? { machines: deps.machines } : {}) },
			);
		case "machineGit":
			return (await import("./turn-box-machine-git-port")).machineGitPort(
				turn,
				call.args,
				{ ...(deps.machines ? { machines: deps.machines } : {}) },
			);
		case "commandReceipt": {
			const receipts = await import("./agent-task-command-receipts");
			const requestId = call.args.requestId ?? "";
			switch (call.args.op) {
				case "claim":
					return receipts.claimAgentTaskCommand(session, requestId);
				case "renew":
					return receipts.renewAgentTaskCommandClaim(session, requestId);
				case "complete": {
					const response = call.args.response as
						| Parameters<typeof receipts.completeAgentTaskCommand>[1]
						| undefined;
					if (typeof response?.id !== "string")
						throw new TurnBoxPortForbidden(call.op);
					return receipts.completeAgentTaskCommand(session, response);
				}
				case "retained": {
					const metadata = await ownMetadata(turn);
					if (!metadata.projectId) return [];
					return [
						...(
							await receipts.retainedTaskCheckResults({
								userId: user,
								projectId: metadata.projectId,
								sessionId: session,
								requestIds: call.args.requestIds ?? [],
							})
						).entries(),
					];
				}
			}
			return null;
		}
		case "canvasRevision":
			return (await import("./canvas-revisions")).savedCanvasRevision(
				session,
				call.args.title,
			);
		case "remoteTool":
			return (await import("./turn-box-tool-port")).remoteToolPort(
				turn,
				{
					tool: call.args.tool,
					input: call.args.input,
					...(call.args.cwd ? { cwd: call.args.cwd } : {}),
				},
				{ ...(deps.machines ? { machines: deps.machines } : {}) },
			);
		case "pushNotices":
			return (
				await import("./git-push-requests")
			).gitPushRequests.claimUnnoticed(user, session);
		case "mcpListing":
			return (await import("./turn-box-mcp-port")).mcpListingPort(turn);
		case "mcpCall":
			return (await import("./turn-box-mcp-port")).mcpCallPort(turn, {
				server: call.args.server,
				tool: call.args.tool,
				input: call.args.input,
			});
		default:
			return NOT_SERVED;
	}
}
