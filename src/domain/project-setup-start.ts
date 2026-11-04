import { isSetupChatTitle } from "./environment-setup";
import type { ChatWaitingOn } from "./sidebar-chats";

type SetupWorkspace = {
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
export function firstBuildRunning(workspace: SetupWorkspace) {
	return FIRST_BUILD_RUNNING.has(workspace.status) && !workspace.build?.rebuild;
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

/** The person's own chat while the project is set up in the background. */
export const SETUP_RUNNING_PLACEHOLDER =
	"Describe a task. Setup keeps running in the background.";

/**
 * The composer's placeholder while the project's setup runs (its first
 * build, or its setup chat working, waiting for the build, or waiting on
 * the person): any chat but the setup chat says it need not wait. Null for
 * the usual placeholder.
 */
export function setupComposerPlaceholder(input: {
	readonly workspace: SetupWorkspace | null | undefined;
	readonly setupChat: SetupChat | null;
	readonly openChatId: string | undefined;
}): string | null {
	const { workspace, setupChat } = input;
	if (!workspace || workspace.status === "failed") return null;
	if (setupChat && setupChat.id === input.openChatId) return null;
	const running =
		firstBuildRunning(workspace) ||
		setupChat?.turnStatus === "running" ||
		Boolean(setupChat?.waitsForSetup) ||
		Boolean(setupChat?.waitingOn && setupChat.waitingOn !== "failed");
	return running ? SETUP_RUNNING_PLACEHOLDER : null;
}
