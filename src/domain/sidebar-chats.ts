import type { SessionTurnStatus } from "./session-item";

export type SidebarChat = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus?: SessionTurnStatus;
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
