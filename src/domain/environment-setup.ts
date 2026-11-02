/** What "Set up environment" puts in a new chat's message box. */
export const ENVIRONMENT_SETUP_PROMPT =
	"Set up this project's environment. Read the README and the manifests, install the dependencies, build, and run the project's checks (typecheck, lint, tests). If install or build needs a secret, ask me for it with request_project_secret. Don't wait on optional runtime services: if something (a dev server, a service, a check) can't run without a secret or an outside service, skip it. Then save what you verified with save_project_environment, and list what you could not verify and why (with the missing secret names) as unverified. Don't change the project's code. Before you finish, run git status --porcelain, restore every tracked file your commands changed (git restore <path>), and only say nothing changed after git status --porcelain prints nothing.";

/** A setup chat's title, whatever its first message says. */
export const ENVIRONMENT_SETUP_TITLE = "Set up environment";

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

/** The chip's request, sent unedited (whitespace aside). */
export function isEnvironmentSetupPrompt(text: string): boolean {
	return normalized(text) === normalized(ENVIRONMENT_SETUP_PROMPT);
}

/**
 * "Set up with the agent" on a message held by a failed setup: the setup
 * chat's request, keeping the message the person sent (not dropped) for a
 * later chat, since a setup chat never commits.
 */
export function setupRequestKeeping(message: string) {
	return `${ENVIRONMENT_SETUP_PROMPT}\n\nThe setup failed before this message could be sent. Keep it for after setup, in a new chat (not here):\n${message.trim()}`;
}
