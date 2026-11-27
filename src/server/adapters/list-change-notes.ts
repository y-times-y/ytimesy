import { hubTopic } from "#/domain/user-hub";
import { noteUserHub } from "./user-hub-notes";

/**
 * What the user's open tabs must re-read when a chat or project list changed
 * (a thread was created, renamed, archived, started, settled, or needs the
 * person; a project was added, archived or removed). Topics name what changed,
 * never what it changed to: the tab reads its own lists (user-hub-store.ts).
 */
export const listChangeTopics = {
	/** One project's chat list, or every list when the project is not at hand. */
	sessions: (projectId?: string | null) => [
		projectId ? hubTopic.sessions(projectId) : hubTopic.sessionsAny,
	],
	/** The project list; its chat lists (the Super agent row) move with it. */
	projects: () => [hubTopic.projects, hubTopic.sessionsAny],
};

/** Fire and forget; bursts are merged by noteUserHub (user-hub-notes.ts). */
export function noteSessionsChanged(
	userId: string | null | undefined,
	projectId?: string | null,
) {
	noteUserHub(userId, listChangeTopics.sessions(projectId));
}

export function noteProjectsChanged(userId: string | null | undefined) {
	noteUserHub(userId, listChangeTopics.projects());
}
