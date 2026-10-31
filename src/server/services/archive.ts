import type { ArchivedKind } from "#/domain/archive";
import {
	expiredArchives,
	projectRootChatIds,
	setChatArchived,
	setProjectArchived,
} from "../adapters/archive";
import { deleteAgentSessionMachine } from "./agent-session-machine";
import { cancelServerTurn } from "./cancel-server-turn";
import { removeProjectMachine } from "./projects";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Archives a chat or a project: running turns stop and it leaves the app,
 * but nothing is deleted; Settings > Archived restores it until the keep
 * ends (purgeExpiredArchives).
 */
export async function archiveOwned(
	userId: string,
	kind: ArchivedKind,
	id: string,
) {
	const chats = kind === "chat" ? [id] : await projectRootChatIds(userId, id);
	for (const chatId of chats) await cancelServerTurn(userId, chatId);
	const archived =
		kind === "chat"
			? await setChatArchived(userId, id, true)
			: await setProjectArchived(userId, id, true);
	if (!archived)
		throw new Error(
			kind === "chat" ? "Chat is not available." : "Project is not available.",
		);
}

export async function restoreOwned(
	userId: string,
	kind: ArchivedKind,
	id: string,
) {
	const restored =
		kind === "chat"
			? await setChatArchived(userId, id, false)
			: await setProjectArchived(userId, id, false);
	if (!restored)
		throw new Error(
			kind === "chat" ? "Chat is not available." : "Project is not available.",
		);
}

/** Deletes an archived chat or project for good: its files, machines and rows. */
export async function deleteArchived(
	machines: Pick<WorkspaceMachines, "destroy" | "destroySnapshot">,
	input: {
		readonly userId: string;
		readonly kind: ArchivedKind;
		readonly id: string;
		readonly projectId: string;
	},
) {
	if (input.kind === "project")
		return removeProjectMachine(machines, {
			userId: input.userId,
			projectId: input.id,
		});
	return deleteAgentSessionMachine(machines, {
		userId: input.userId,
		projectId: input.projectId,
		sessionId: input.id,
	});
}

/** Deletes archived chats and projects past the keep; the next run retries failures. */
export async function purgeExpiredArchives(
	machines: Pick<WorkspaceMachines, "destroy" | "destroySnapshot">,
) {
	for (const item of await expiredArchives())
		await deleteArchived(machines, item).catch(() =>
			console.warn("Archived item deletion failed; retried next run.", {
				kind: item.kind,
			}),
		);
}
