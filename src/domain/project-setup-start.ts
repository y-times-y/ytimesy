import { isSetupChatTitle } from "./environment-setup";
import type { ChatWaitingOn } from "./sidebar-chats";

type SetupWorkspace = {
	readonly projectId: string;
	readonly status: string;
	readonly build?: { readonly rebuild: boolean } | null;
};

const FIRST_BUILD_RUNNING = new Set([
	"queued",
	"provisioning",
	"cloning",
	"installing",
]);

/** The project's first environment build runs (a rebuild keeps its working environment). */
export function firstBuildRunning(
	workspace: Pick<SetupWorkspace, "status" | "build">,
) {
	return FIRST_BUILD_RUNNING.has(workspace.status) && !workspace.build?.rebuild;
}

/**
 * When a tab starts a new project's setup, in the background: the open
 * chat stays the person's and nothing navigates. The setup request goes to
 * the server as a new chat's send (the project's one setup message id, so a
 * second tab or a task's own start finds the same chat); the server holds it
 * in that chat until the build is ready, then the setup agent runs there.
 *
 * It starts while the project's first build runs, or once that build is
 * ready if this tab saw it running (no model was known yet, say), and only
 * while nothing was sent: a task sent first starts the setup beside it on
 * the server. A project with any chat in use, or one this tab already
 * started, never starts it again.
 */
export function startsBackgroundProjectSetup(input: {
	readonly projectId: string | undefined;
	readonly workspace: SetupWorkspace | null | undefined;
	/** The project's chats; undefined while they load. */
	readonly chats: readonly { readonly unused?: boolean }[] | undefined;
	readonly startedInThisTab: ReadonlySet<string>;
	/** Projects whose first build this tab saw running. */
	readonly sawFirstBuildInThisTab: ReadonlySet<string>;
	/** The person sent a task in this project from this tab. */
	readonly taskSent: boolean;
}): boolean {
	const { projectId, workspace, chats } = input;
	if (!projectId || input.startedInThisTab.has(projectId)) return false;
	if (!workspace || workspace.projectId !== projectId) return false;
	if (input.taskSent || chats === undefined) return false;
	// The open empty chat is listed as unused: it is not in use.
	if (chats.some((chat) => !chat.unused)) return false;
	if (firstBuildRunning(workspace)) return true;
	return (
		workspace.status === "ready" && input.sawFirstBuildInThisTab.has(projectId)
	);
}

type SetupChat = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus?: string;
	readonly waitingOn?: ChatWaitingOn | null;
	readonly waitsForSetup?: boolean;
};

/** The project's setup chat, the newest by the list's order (latest first). */
export function projectSetupChat<Chat extends SetupChat>(
	chats: readonly Chat[] | undefined,
): Chat | null {
	return chats?.find((chat) => isSetupChatTitle(chat.title)) ?? null;
}
