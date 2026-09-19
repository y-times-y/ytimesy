import { describe, expect, it } from "vitest";
import {
	backgroundTurnPollChatIds,
	chatsListedInSidebar,
	composerBusyForOpenChat,
	composerHarnessForChat,
	listedChatHarnessId,
	listedChatModelId,
	listedChatTurnStatus,
	newChatIsActive,
	selectedChatIdAfterDelete,
	sessionViewAppliesToOpenChat,
	sidebarChatIsRunning,
	projectFolderIsExpanded,
	sidebarChatsEmptyCopy,
	sidebarHasRunningChat,
	toggleCollapsedProjectIds,
	withProjectExpanded,
	sidebarIsPinnedInStorage,
	sidebarPinnedStorageValue,
	chatsWithPinnedFirst,
	togglePinnedChatIds,
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

describe("project folder collapse", () => {
	it("keeps only the selected project open unless the user collapsed it", () => {
		expect(
			projectFolderIsExpanded({
				projectId: "a",
				selectedProjectId: "a",
				collapsedIds: [],
			}),
		).toBe(true);
		expect(
			projectFolderIsExpanded({
				projectId: "a",
				selectedProjectId: "a",
				collapsedIds: ["a"],
			}),
		).toBe(false);
		expect(
			projectFolderIsExpanded({
				projectId: "b",
				selectedProjectId: "a",
				collapsedIds: [],
			}),
		).toBe(false);
	});

	it("toggles a collapsed folder and reopens it on select", () => {
		expect(toggleCollapsedProjectIds(["a"], "a")).toEqual([]);
		expect(toggleCollapsedProjectIds([], "a")).toEqual(["a"]);
		expect(withProjectExpanded(["a", "b"], "a")).toEqual(["b"]);
	});
});

describe("sidebar pin storage", () => {
	it("pins only the stored expanded state", () => {
		expect(sidebarIsPinnedInStorage("1")).toBe(true);
		expect(sidebarIsPinnedInStorage("0")).toBe(false);
		expect(sidebarIsPinnedInStorage(null)).toBe(false);
		expect(sidebarPinnedStorageValue(true)).toBe("1");
		expect(sidebarPinnedStorageValue(false)).toBe("0");
	});
});

describe("pinned chats", () => {
	it("toggles a chat pin and keeps pinned rows first", () => {
		expect(togglePinnedChatIds([], "b")).toEqual(["b"]);
		expect(togglePinnedChatIds(["b"], "b")).toEqual([]);
		expect(
			chatsWithPinnedFirst(
				[{ id: "a", title: "a" }, { id: "b", title: "b" }, { id: "c", title: "c" }],
				["c", "b"],
			).map((chat) => chat.id),
		).toEqual(["b", "c", "a"]);
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

	it("marks the collapsed rail when any chat is still running", () => {
		expect(
			sidebarHasRunningChat({
				chats: [
					{ id: "a", title: "fix login", turnStatus: "running" },
					{ id: "b", title: "add snapshot copy", turnStatus: "idle" },
				],
				busyChatIds: [],
				openChatId: "b",
				openTurnStatus: "idle",
			}),
		).toBe(true);
		expect(
			sidebarHasRunningChat({
				chats: [{ id: "b", title: "add snapshot copy", turnStatus: "idle" }],
				busyChatIds: [],
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
		expect(
			listedChatTurnStatus(
				[
					{ id: "a", title: "fix login", turnStatus: "running" },
					{ id: "b", title: "add snapshot copy", turnStatus: "idle" },
				],
				"a",
			),
		).toBe("running");
		expect(
			listedChatModelId(
				[
					{
						id: "a",
						title: "fix login",
						listedModelId: "opencode/big-pickle",
						harnessId: "opencode",
					},
					{ id: "b", title: "add snapshot copy" },
				],
				"a",
			),
		).toBe("opencode/big-pickle");
		expect(
			listedChatHarnessId(
				[
					{
						id: "a",
						title: "fix login",
						harnessId: "opencode",
					},
					{ id: "b", title: "add snapshot copy" },
				],
				"a",
				"codex",
			),
		).toBe("opencode");
		expect(
			listedChatHarnessId(
				[{ id: "b", title: "add snapshot copy" }],
				"b",
				"opencode",
			),
		).toBe("opencode");
		expect(
			composerHarnessForChat({
				listedHarnessId: "codex",
				connectionProvider: "opencode",
				fallback: "opencode",
			}),
		).toBe("codex");
		expect(
			composerHarnessForChat({
				listedHarnessId: null,
				connectionProvider: "claude",
				fallback: "opencode",
			}),
		).toBe("claude");
	});
});

describe("background turn poll", () => {
	it("polls a running sibling after the user switches chats", () => {
		expect(
			backgroundTurnPollChatIds({
				chats: [
					{ id: "a", title: "fix login", turnStatus: "running" },
					{ id: "b", title: "add snapshot copy", turnStatus: "idle" },
				],
				openChatId: "b",
				busyChatIds: [],
			}),
		).toEqual(["a"]);
	});

	it("does not poll the open chat or a send that is still in flight", () => {
		expect(
			backgroundTurnPollChatIds({
				chats: [
					{ id: "a", title: "fix login", turnStatus: "running" },
					{ id: "b", title: "add snapshot copy", turnStatus: "running" },
				],
				openChatId: "a",
				busyChatIds: ["b"],
			}),
		).toEqual([]);
	});

	it("keeps a completed sibling view on that chat instead of the open one", () => {
		expect(
			sessionViewAppliesToOpenChat({
				openChatId: "b",
				agentSessionId: "a",
			}),
		).toBe(false);
		expect(
			sessionViewAppliesToOpenChat({
				openChatId: "a",
				agentSessionId: "a",
			}),
		).toBe(true);
	});
});
