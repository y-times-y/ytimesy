/**
 * Every chat runs in a project, and a project is a GitHub repository. Without
 * one a send has nowhere to go, so the composer keeps the text and says how to
 * get a project instead of starting a chat the server will refuse. A new
 * account adds its first project here: the first run picks no repository.
 */
export const NO_PROJECT_NOTICE = "Choose a repository to start a chat.";

export function composerProjectNotice(input: {
	readonly selectedProjectId?: string;
}): string | null {
	return input.selectedProjectId ? null : NO_PROJECT_NOTICE;
}
