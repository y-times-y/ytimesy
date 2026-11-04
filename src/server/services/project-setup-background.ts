import { Effect } from "effect";
import {
	ENVIRONMENT_SETUP_PROMPT,
	ENVIRONMENT_SETUP_TITLE,
	initialSetupMessageId,
} from "#/domain/environment-setup";
import { SessionItemId } from "#/domain/ids";
import {
	chooseSetupModel,
	SETUP_WAITS_FOR_MODEL,
	type SetupModel,
} from "#/domain/setup-model";
import {
	claimInitialSetupChat,
	latestListedModelForUser,
} from "../adapters/agent-sessions";
import { replaceIdleSessionItems } from "../adapters/background-command-sessions";
import { codexSubscriptionCatalog } from "../adapters/codex-subscription";
import { database } from "../adapters/database";
import {
	markEnvironmentSetupChat,
	otherProjectSetupChat,
} from "../adapters/environment-setup-chats";
import { workspaceForProject } from "../adapters/workspaces";
import { loadAgentAccountState } from "../auth/agent-account";
import { apiModelCatalog } from "./api-workspace-session";
import { sendComposerMessage } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

/** The model the person's setup runs on now, or null when nothing is connected. */
export async function setupModelFor(
	userId: string,
): Promise<SetupModel | null> {
	const [lastUsed, codex, api] = await Promise.all([
		latestListedModelForUser(userId).catch(() => null),
		loadAgentAccountState(userId)
			.then((state) =>
				state.managed && state.account.status === "connected"
					? codexSubscriptionCatalog(userId)
					: [],
			)
			.catch(() => []),
		apiModelCatalog(userId).catch(() => []),
	]);
	return chooseSetupModel({ lastUsed, catalogs: { codex, api } });
}

export type ProjectSetupStart =
	| "started"
	| "exists"
	| "waits-for-model"
	| "no-workspace";

/**
 * A new project's setup, started by the server (tab open or not): its one
 * setup chat is claimed (initialSetupMessageId: a second start, from the
 * build's finish or another request, finds it) and the setup request goes
 * in as the composer's send would. While the first build runs it waits in
 * that chat and goes once the build is ready (deliverHeldSends); after it, it
 * starts at once. Nothing on any tab navigates to it.
 *
 * With no connected model the chat still opens, with one line saying what
 * it waits for; Rerun setup starts it then.
 */
export async function startProjectSetupInBackground(
	machines: WorkspaceMachines,
	userId: string,
	projectId: string,
): Promise<ProjectSetupStart> {
	const workspace = await workspaceForProject(userId, projectId);
	if (!workspace) return "no-workspace";
	if (await otherProjectSetupChat(userId, projectId, null)) return "exists";
	const model = await setupModelFor(userId);
	if (!model) {
		const claimed = await claimInitialSetupChat({
			userId,
			projectId,
			workspaceId: workspace.id,
			harness: "codex",
			title: ENVIRONMENT_SETUP_TITLE,
		});
		if (!claimed) return "no-workspace";
		if (!claimed.created) return "exists";
		await markEnvironmentSetupChat(
			userId,
			claimed.session.id,
			ENVIRONMENT_SETUP_TITLE,
		);
		await replaceIdleSessionItems(
			userId,
			claimed.session.id,
			[],
			[
				{
					kind: "notice",
					id: SessionItemId(`${claimed.session.id}:setup-waits-for-model`),
					message: SETUP_WAITS_FOR_MODEL,
				},
			],
		);
		return "waits-for-model";
	}
	await Effect.runPromise(
		sendComposerMessage(
			machines,
			{
				userId,
				projectId,
				harnessId: model.harnessId,
				createNew: true,
			},
			{
				text: ENVIRONMENT_SETUP_PROMPT,
				modelId: model.modelId,
				idempotencyKey: initialSetupMessageId(projectId),
				environmentSetup: true,
			},
		),
	);
	return "started";
}

/**
 * A workspace's first environment build just became ready: its project's
 * setup starts if nothing started it when the project was added (a lost
 * request, an older tab). Never for a later build: a project set up before
 * this existed does not get a setup chat on its next rebuild.
 */
export async function startProjectSetupAfterFirstBuild(
	machines: WorkspaceMachines,
	workspaceId: string,
) {
	const workspace = await setupWorkspace(workspaceId);
	if (!workspace || workspace.readyBuilds !== 1) return null;
	return startProjectSetupInBackground(
		machines,
		workspace.userId,
		workspace.projectId,
	);
}

/**
 * The project-setup job, dispatched when a project's first environment is
 * queued. A workspace that already had a ready build is an older project:
 * nothing starts.
 */
export async function startProjectSetupForWorkspace(
	machines: WorkspaceMachines,
	workspaceId: string,
) {
	const workspace = await setupWorkspace(workspaceId);
	if (!workspace || workspace.readyBuilds > 1) return null;
	return startProjectSetupInBackground(
		machines,
		workspace.userId,
		workspace.projectId,
	);
}

async function setupWorkspace(workspaceId: string) {
	const result = await database().query<{
		user_id: string;
		project_id: string;
		ready_builds: string;
	}>(
		`select w.user_id,w.project_id,
		  (select count(*) from environment_build b where b.workspace_id=w.id and b.status='ready') as ready_builds
		 from workspace w where w.id=$1`,
		[workspaceId],
	);
	const row = result.rows[0];
	return row
		? {
				userId: row.user_id,
				projectId: row.project_id,
				readyBuilds: Number(row.ready_builds),
			}
		: null;
}
