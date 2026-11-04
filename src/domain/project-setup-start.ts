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

type SetupState = {
	readonly workspace: SetupWorkspace | null | undefined;
	readonly setupChat: SetupChat | null;
	readonly openChatId: string | undefined;
};

/**
 * The line beside the person's composer while the project is set up in its
 * own chat: running (its first build, or the setup chat working or waiting
 * for the build) or needing the person (a secret, a question). None in the
 * setup chat itself, once setup is done, or after a failed build (its
 * failure shows there instead).
 */
export function setupIndicator(input: SetupState): {
	readonly kind: "running" | "needs-you";
	readonly text: string;
	readonly action: string;
	/** The setup chat the action opens; null before it exists. */
	readonly chatId: string | null;
} | null {
	const { workspace, setupChat } = input;
	if (!workspace || workspace.status === "failed") return null;
	if (setupChat && setupChat.id === input.openChatId) return null;
	const chatId = setupChat?.id ?? null;
	const waitingOn = setupChat?.waitingOn;
	if (waitingOn && waitingOn !== "failed")
		return {
			kind: "needs-you",
			text: waitingOn === "secret" ? "Setup needs a secret" : "Setup needs you",
			action: "Open",
			chatId,
		};
	const running =
		firstBuildRunning(workspace) ||
		setupChat?.turnStatus === "running" ||
		Boolean(setupChat?.waitsForSetup);
	return running
		? {
				kind: "running",
				text: "Setup is running in another chat. You can keep working.",
				action: "View setup",
				chatId,
			}
		: null;
}

/** The composer's placeholder while setup runs (setupIndicator); null for the usual one. */
export function setupComposerPlaceholder(input: SetupState): string | null {
	return setupIndicator(input) ? SETUP_RUNNING_PLACEHOLDER : null;
}
