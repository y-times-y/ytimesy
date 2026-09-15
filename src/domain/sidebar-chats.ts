export type SidebarChat = {
	readonly id: string;
	readonly title: string;
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
