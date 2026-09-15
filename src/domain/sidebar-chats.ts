import type { AgentProviderId } from "./agent-provider";
import { isTurnRunning, type SessionTurnStatus } from "./session-item";

export type SidebarChat = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus?: SessionTurnStatus;
	readonly listedModelId?: string | null;
	readonly harnessId?: AgentProviderId | null;
};

export function chatsListedInSidebar(input: {
	projectSelected: boolean;
	hasUserMessage: boolean;
	title: string;
}): readonly SidebarChat[] {
	if (!input.projectSelected || !input.hasUserMessage) return [];
	return [{ id: "current", title: input.title }];
}

export function sidebarChatsEmptyCopy(input: {
	loading: boolean;
	projectSelected: boolean;
}): string | null {
	if (input.loading) return "Loading chats…";
	if (!input.projectSelected) return "Pick a repository to start a chat.";
	return "No chats yet.";
}

export function newChatIsActive(input: {
	projectSelected: boolean;
	hasUserMessage: boolean;
}): boolean {
	return input.projectSelected && !input.hasUserMessage;
}

export const SIDEBAR_PINNED_STORAGE_KEY = "ytimesy-sidebar-pinned";

export function sidebarIsPinnedInStorage(value: string | null): boolean {
	return value === "1";
}

export function sidebarPinnedStorageValue(pinned: boolean): "1" | "0" {
	return pinned ? "1" : "0";
}

export function selectedChatIdAfterDelete(input: {
	readonly chats: readonly { readonly id: string }[];
	readonly selectedChatId: string | undefined;
	readonly deletedChatId: string;
}): string | undefined {
	if (input.selectedChatId !== input.deletedChatId) {
		return input.selectedChatId;
	}
	return input.chats.find((chat) => chat.id !== input.deletedChatId)?.id;
}

export function withBusyChat(
	ids: readonly string[],
	chatId: string | undefined,
): string[] {
	if (!chatId || ids.includes(chatId)) return [...ids];
	return [...ids, chatId];
}

export function withoutBusyChat(
	ids: readonly string[],
	chatId: string | undefined,
): string[] {
	if (!chatId) return [...ids];
	return ids.filter((id) => id !== chatId);
}

export function composerBusyForOpenChat(input: {
	readonly openChatId: string | undefined;
	readonly busyChatIds: readonly string[];
}): boolean {
	return Boolean(
		input.openChatId && input.busyChatIds.includes(input.openChatId),
	);
}

export function sidebarChatIsRunning(input: {
	readonly chatId: string;
	readonly turnStatus?: SessionTurnStatus;
	readonly busyChatIds: readonly string[];
	readonly openChatId?: string;
	readonly openTurnStatus?: SessionTurnStatus;
	readonly openSideTurnStatus?: SessionTurnStatus;
}): boolean {
	if (input.busyChatIds.includes(input.chatId)) return true;
	if (input.chatId === input.openChatId) {
		return (
			input.openTurnStatus === "running" ||
			input.openSideTurnStatus === "running"
		);
	}
	return input.turnStatus === "running";
}

export function sidebarHasRunningChat(input: {
	readonly chats: readonly SidebarChat[];
	readonly busyChatIds: readonly string[];
	readonly openChatId?: string;
	readonly openTurnStatus?: SessionTurnStatus;
	readonly openSideTurnStatus?: SessionTurnStatus;
}): boolean {
	return input.chats.some((chat) =>
		sidebarChatIsRunning({
			chatId: chat.id,
			turnStatus: chat.turnStatus,
			busyChatIds: input.busyChatIds,
			openChatId: input.openChatId,
			openTurnStatus: input.openTurnStatus,
			openSideTurnStatus: input.openSideTurnStatus,
		}),
	);
}

export function withChatTurnStatus(
	chats: readonly SidebarChat[],
	chatId: string | undefined,
	turnStatus: SessionTurnStatus,
): SidebarChat[] {
	if (!chatId) return [...chats];
	return chats.map((chat) =>
		chat.id === chatId ? { ...chat, turnStatus } : chat,
	);
}

export function listedChatTurnStatus(
	chats: readonly SidebarChat[],
	chatId: string,
): SessionTurnStatus {
	return chats.find((chat) => chat.id === chatId)?.turnStatus ?? "idle";
}

export function listedChatModelId(
	chats: readonly SidebarChat[],
	chatId: string,
): string {
	return chats.find((chat) => chat.id === chatId)?.listedModelId?.trim() ?? "";
}

export function listedChatHarnessId(
	chats: readonly SidebarChat[],
	chatId: string,
	fallback: AgentProviderId,
): AgentProviderId {
	return chats.find((chat) => chat.id === chatId)?.harnessId ?? fallback;
}

export function composerHarnessForChat(input: {
	readonly listedHarnessId?: AgentProviderId | null;
	readonly connectionProvider?: AgentProviderId | null;
	readonly fallback: AgentProviderId;
}): AgentProviderId {
	return input.listedHarnessId ?? input.connectionProvider ?? input.fallback;
}

/**
 * A running sibling keeps polling after the user switches chats. Skip the
 * open row (its own interval handles that) and any chat whose Send is still
 * in flight so the submit and the poll do not share a guest.
 */
export function backgroundTurnPollChatIds(input: {
	readonly chats: readonly SidebarChat[];
	readonly openChatId?: string;
	readonly busyChatIds: readonly string[];
}): string[] {
	return input.chats
		.filter((chat) => {
			if (chat.id === input.openChatId) return false;
			if (input.busyChatIds.includes(chat.id)) return false;
			return isTurnRunning(chat.turnStatus ?? "idle");
		})
		.map((chat) => chat.id);
}

export function sessionViewAppliesToOpenChat(input: {
	readonly openChatId?: string;
	readonly agentSessionId: string | null;
}): boolean {
	return Boolean(
		input.agentSessionId && input.agentSessionId === input.openChatId,
	);
}
