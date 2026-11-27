import {
	enableDefaultYProjects,
	ensureYSquaredChat,
	projectsMissingYSquared,
	projectYMode,
} from "../adapters/y-mode";
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
		// A project added again after it was removed comes back with the Y
		// mode it had before Y² was the default; it follows the default now.
		await enableDefaultYProjects(userId);
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

/**
 * Self-healing, run on every page load: any live project of a user with Y²
 * on that has no Y² chat gets one (idempotent: the partial unique index
 * decides a race), and a project that never chose follows the default. Logs
 * `y_squared.missing` (project count) whenever it finds one lacking, and
 * `y_squared.repair_failed` if the repair itself fails. Never throws.
 */
export async function repairMissingYSquared(userId: string): Promise<number> {
	try {
		const enabled = await enableDefaultYProjects(userId);
		const missing = await projectsMissingYSquared(userId);
		if (!missing.length) return 0;
		console.warn("y_squared.missing", {
			projects: missing.length,
			enabledByDefault: enabled.length,
		});
		let created = 0;
		for (const projectId of missing)
			if (await createProjectYSquared(userId, projectId)) created += 1;
		console.warn("y_squared.repaired", { created, of: missing.length });
		return created;
	} catch (error) {
		console.error("y_squared.repair_failed", error);
		return 0;
	}
}
