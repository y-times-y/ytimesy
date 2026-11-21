import type { ToolSet } from "ai";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import {
	DESCRIBE_SECRET_TOOL,
	SOURCE_AGENT_SECRETS,
} from "#/domain/project-secret";
import { REQUEST_PUSH_APPROVAL_TOOL } from "#/domain/push-approval";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import { describeSecretTools } from "../services/describe-secret-tool";
import {
	environmentSetupTools,
	SAVE_PROJECT_ENVIRONMENT_TOOL,
} from "../services/environment-setup-tool";
import {
	loadAgentProjectSecrets,
	saveAccountWideSecret,
	saveVisibleProjectSecret,
	setSecretDescription,
} from "../services/project-secrets";
import {
	countCommitsCommand,
	pushApprovalTools,
} from "../services/push-approval-tool";
import {
	SAVE_PROJECT_SECRET_TOOL,
	saveProjectSecretTools,
} from "../services/save-project-secret-tool";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { agentSessionMetadataForOwner } from "./agent-sessions";
import type { ApiTurn } from "./api-turns";
import { gitPushRequests } from "./git-push-requests";

/** The tools a box runs on the edge whole: their work needs a value or a record the box must not hold. */
export const REMOTE_TOOLS = [
	SAVE_PROJECT_SECRET_TOOL,
	DESCRIBE_SECRET_TOOL,
	REQUEST_PUSH_APPROVAL_TOOL,
	SAVE_PROJECT_ENVIRONMENT_TOOL,
] as const;

/**
 * Tools a box runs on the edge whole (docs/turn-runner-boxes.md, "Tools the
 * edge runs"): saving the project's environment setup (project settings and
 * the image rebuild), saving a secret (its value is read on the chat's VM and saved
 * here, never passing through the box), describing one (checked against the
 * project's secret values, which only the edge holds) and asking for a push
 * approval (the push request records). Each is the same tool the Durable
 * Object runs, built here for the turn's own user, project, chat and VM.
 */
export async function remoteToolPort(
	turn: ApiTurn,
	call: {
		readonly tool: string;
		readonly input: unknown;
		readonly cwd?: string;
	},
	deps: { readonly machines?: () => WorkspaceMachines } = {},
): Promise<unknown> {
	const chat = await agentSessionMetadataForOwner(
		turn.user_id,
		turn.session_id,
	);
	if (!chat?.projectId || chat.parentSessionId)
		throw new TurnBoxPortForbidden("tool:chat");
	const projectId = chat.projectId;
	const vm = () => {
		if (!deps.machines || !chat.providerRef)
			throw new TurnBoxPortForbidden("tool:vm");
		return { machines: deps.machines(), vm: WorkspaceId(chat.providerRef) };
	};
	let tools: ToolSet;
	switch (call.tool) {
		case SAVE_PROJECT_SECRET_TOOL:
			tools = saveProjectSecretTools({
				runInWorkspace: (command) => {
					const ready = vm();
					return ready.machines.exec(
						ready.vm,
						`${SOURCE_AGENT_SECRETS}\n${command}`,
						30_000,
					);
				},
				save: async ({ scope, ...secret }) => {
					if (scope === "account")
						await saveAccountWideSecret({ userId: turn.user_id, ...secret });
					else
						await saveVisibleProjectSecret({
							userId: turn.user_id,
							projectId,
							...secret,
						});
				},
			});
			break;
		case DESCRIBE_SECRET_TOOL: {
			const { redact } = await loadAgentProjectSecrets(turn.user_id, projectId);
			tools = describeSecretTools({
				values: () => redact,
				save: ({ name, description }) =>
					setSecretDescription({
						userId: turn.user_id,
						projectId,
						name,
						description,
					}),
			});
			break;
		}
		case REQUEST_PUSH_APPROVAL_TOOL:
			tools = pushApprovalTools({
				userId: turn.user_id,
				projectId,
				sessionId: chat.id,
				requests: gitPushRequests,
				countCommits: async (oldId, newId) => {
					const ready = vm();
					const counted = await ready.machines.exec(
						ready.vm,
						`cd ${posixShellQuoted(call.cwd ?? ".")} && ${countCommitsCommand(oldId, newId)}`,
						15_000,
					);
					const count = Number(counted.stdout.trim());
					return counted.exitCode === 0 && Number.isInteger(count)
						? count
						: null;
				},
			});
			break;
		case SAVE_PROJECT_ENVIRONMENT_TOOL:
			tools = environmentSetupTools({
				userId: turn.user_id,
				projectId,
				sessionId: chat.id,
			});
			break;
		default:
			throw new TurnBoxPortForbidden("tool:name");
	}
	const execute = tools[call.tool]?.execute;
	if (!execute) throw new TurnBoxPortForbidden("tool:name");
	return execute(call.input as never, {
		toolCallId: "box",
		messages: [],
		context: {},
	});
}
