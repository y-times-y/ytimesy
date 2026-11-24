import { ensureYSquaredChat, projectYMode } from "../adapters/y-mode";
import { resolveLinkedChatRoute } from "./linked-chat-route";

/**
 * A project's Super agent exists from the moment the project is added (with
 * its workspace row), not from its first thread: the sidebar shows it at
 * once, with a welcome line. It carries the model the person already
 * connected; with none, it is created dormant (no model, no wakes) and takes
 * the first model they connect. Never throws: a failure here must not fail
 * adding the project (the page-load path creates a missing Super agent).
 */
export async function createProjectYSquared(
	userId: string,
	projectId: string,
): Promise<string | null> {
	try {
		const mode = await projectYMode(userId, projectId);
		if (!mode?.enabled) return null;
		if (mode.ySquaredId) return mode.ySquaredId;
		const route = await resolveLinkedChatRoute({
			userId,
			harnessId: "codex",
			modelId: "",
		}).catch(() => null);
		return await ensureYSquaredChat(userId, projectId, route);
	} catch (error) {
		console.error("y_squared.create_on_add_failed", error);
		return null;
	}
}
