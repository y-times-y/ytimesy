import type { AgentProviderId } from "./agent-provider";
import { parseClaudeCodeRouteId } from "./claude-code-route";
import type { SettingsSection } from "./workspace-settings";

/**
 * What the server knows stops a send, read with the chat view:
 * - `github`: a new chat checks out its branch with the user's GitHub, which is not connected;
 * - `no_model`: no API key or subscription lists a model;
 * - `claude_token`: Anthropic refused the saved Claude subscription token.
 */
export type SendBlocker = "github" | "no_model" | "claude_token";

/** The one reason the composer shows when a send cannot go, and its fix. */
export type ComposerSendBlock = {
	readonly kind: SendBlocker | "model_unavailable";
	readonly message: string;
	readonly actionLabel: string;
	/** Opens this Settings section, or the model picker. */
	readonly action: SettingsSection | "model_picker";
};

export const GITHUB_SEND_BLOCK_MESSAGE = "Connect GitHub to send.";

const BLOCKS: Record<ComposerSendBlock["kind"], ComposerSendBlock> = {
	github: {
		kind: "github",
		message: GITHUB_SEND_BLOCK_MESSAGE,
		actionLabel: "Connect GitHub",
		action: "github",
	},
	claude_token: {
		kind: "claude_token",
		message: "Claude subscription needs a new token.",
		actionLabel: "Open Settings",
		action: "agents",
	},
	no_model: {
		kind: "no_model",
		message: "Add a model to send.",
		actionLabel: "Open Settings",
		action: "agents",
	},
	model_unavailable: {
		kind: "model_unavailable",
		message: "Pick another model.",
		actionLabel: "Choose model",
		action: "model_picker",
	},
};

/**
 * Why a send from the composer cannot go, or null when it can (as far as
 * these checks know; sign-in, setup and running turns have their own UI).
 * `availableModelIds` is the runtime's live catalog, null while unknown.
 */
export function composerSendBlock(input: {
	readonly harnessId: AgentProviderId;
	readonly blockers?: readonly SendBlocker[];
	readonly modelId: string;
	readonly availableModelIds: readonly string[] | null;
}): ComposerSendBlock | null {
	const blockers = input.blockers ?? [];
	if (input.harnessId === "api") {
		const modelBlock = apiModelBlock(input, blockers);
		if (modelBlock) return modelBlock;
	}
	return blockers.includes("github") ? BLOCKS.github : null;
}

/**
 * Enter (or Send) with this draft: the block it runs into, or null to send.
 * An empty draft sends nothing, so it names no block either.
 */
export function blockedSendAttempt(
	text: string,
	block: ComposerSendBlock | null,
): ComposerSendBlock | null {
	return text.trim() ? block : null;
}

function apiModelBlock(
	input: {
		readonly modelId: string;
		readonly availableModelIds: readonly string[] | null;
	},
	blockers: readonly SendBlocker[],
): ComposerSendBlock | null {
	const modelId = input.modelId.trim();
	const available = input.availableModelIds;
	if (modelId && (available === null || available.includes(modelId))) {
		// The catalog is still loading: only the server's own facts decide.
		if (available !== null || !blockers.includes("no_model")) return null;
	}
	const noModels = blockers.includes("no_model") || available?.length === 0;
	// With no model chosen, a refused token is the reason only when nothing else lists.
	const claude = modelId ? parseClaudeCodeRouteId(modelId) !== null : noModels;
	if (claude && blockers.includes("claude_token")) return BLOCKS.claude_token;
	return noModels ? BLOCKS.no_model : BLOCKS.model_unavailable;
}

/**
 * Whether sending in this chat checks out a branch with the user's GitHub
 * (commitChatBranchForSubmission): a new chat, or one whose picked branch is
 * not checked out yet. Subagents and chats on their branch never ask.
 */
export function chatSendNeedsGithub(
	chat: {
		readonly parentSessionId?: string | null;
		readonly workingBranch?: string | null;
		readonly selectedBranch?: string | null;
		readonly hasConversation: boolean;
	} | null,
): boolean {
	if (!chat) return true;
	if (chat.parentSessionId) return false;
	if (chat.workingBranch) return false;
	return !chat.hasConversation || Boolean(chat.selectedBranch);
}
