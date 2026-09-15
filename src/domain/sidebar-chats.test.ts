import { describe, expect, it } from "vitest";
import {
	chatsListedInSidebar,
	composerBusyForOpenChat,
	newChatIsActive,
	selectedChatIdAfterDelete,
	sidebarChatIsRunning,
	sidebarChatsEmptyCopy,
	withBusyChat,
	withChatTurnStatus,
	withoutBusyChat,
} from "./sidebar-chats";

describe("chatsListedInSidebar", () => {
	it("does not list a chat until the project has a user message", () => {
		expect(
			chatsListedInSidebar({
				projectSelected: true,
				hasUserMessage: false,
				title: "New session",
			}),
		).toEqual([]);
		expect(
			chatsListedInSidebar({
				projectSelected: false,
				hasUserMessage: true,
				title: "fix login",
			}),
		).toEqual([]);
	});

	it("lists the current session title as a chat", () => {
		expect(
			chatsListedInSidebar({
				projectSelected: true,
				hasUserMessage: true,
				title: "fix the composer",
			}),
		).toEqual([{ id: "current", title: "fix the composer" }]);
	});
});

describe("sidebar empty copy", () => {
	it("asks for a repository before showing chats", () => {
		expect(
			sidebarChatsEmptyCopy({ loading: false, projectSelected: false }),
		).toBe("Pick a repository to start a chat.");
		expect(
			sidebarChatsEmptyCopy({ loading: false, projectSelected: true }),
		).toBe("No chats yet.");
	});

	it("treats an empty selected project as the active new chat", () => {
		expect(
			newChatIsActive({ projectSelected: true, hasUserMessage: false }),
		).toBe(true);
		expect(
			newChatIsActive({ projectSelected: true, hasUserMessage: true }),
		).toBe(false);
	});
});

describe("selectedChatIdAfterDelete", () => {
	const chats = [{ id: "a" }, { id: "b" }, { id: "c" }];

	it("keeps the open chat when another row is removed", () => {
		expect(
			selectedChatIdAfterDelete({
				chats,
				selectedChatId: "b",
				deletedChatId: "a",
			}),
		).toBe("b");
	});

	it("opens the next remaining chat when the open chat is removed", () => {
		expect(
			selectedChatIdAfterDelete({
				chats,
				selectedChatId: "a",
				deletedChatId: "a",
			}),
		).toBe("b");
	});

	it("clears selection when the last chat is removed", () => {
		expect(
			selectedChatIdAfterDelete({
				chats: [{ id: "a" }],
				selectedChatId: "a",
				deletedChatId: "a",
			}),
		).toBeUndefined();
	});
});

describe("parallel chat busy", () => {
	it("only disables the composer for the chat that is in flight", () => {
		expect(
			composerBusyForOpenChat({
				openChatId: "b",
				busyChatIds: withBusyChat(["a"], "a"),
			}),
		).toBe(false);
		expect(
			composerBusyForOpenChat({
				openChatId: "a",
				busyChatIds: ["a"],
			}),
		).toBe(true);
	});

	it("shows a sibling as running while this chat stays idle", () => {
		expect(
			sidebarChatIsRunning({
				chatId: "a",
				turnStatus: "running",
				busyChatIds: [],
				openChatId: "b",
				openTurnStatus: "idle",
			}),
		).toBe(true);
		expect(
			sidebarChatIsRunning({
				chatId: "b",
				turnStatus: "idle",
				busyChatIds: withoutBusyChat(["a"], "a"),
				openChatId: "b",
				openTurnStatus: "idle",
			}),
		).toBe(false);
	});

	it("marks only that chat running in the listed rows", () => {
		expect(
			withChatTurnStatus(
				[
					{ id: "a", title: "fix login", turnStatus: "idle" },
					{ id: "b", title: "add snapshot copy", turnStatus: "idle" },
				],
				"a",
				"running",
			),
		).toEqual([
			{ id: "a", title: "fix login", turnStatus: "running" },
			{ id: "b", title: "add snapshot copy", turnStatus: "idle" },
		]);
	});
});
