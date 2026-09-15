import { describe, expect, it } from "vitest";
import {
	chatsListedInSidebar,
	newChatIsActive,
	sidebarChatsEmptyCopy,
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
