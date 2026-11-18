import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	backgroundTurnPollChatIds,
	chatOpenedWithProject,
	chatsToReadAhead,
	chatsWithPinnedFirst,
	composerBusyForOpenChat,
	composerHarnessForChat,
	listedChatHarnessId,
	listedChatModelId,
	listedChatTurnStatus,
	newChatIsActive,
	projectFolderIsExpanded,
	projectsByRecentActivity,
	projectsLatestChatsToReadAhead,
	recentSections,
	recentSidebarChats,
	recentY2Chats,
	type SidebarChat,
	selectedChatIdAfterDelete,
	sessionViewAppliesToOpenChat,
	sessionWithoutOpenChat,
	sidebarChatIsRunning,
	sidebarChatsEmptyCopy,
	sidebarIsPinnedInStorage,
	sidebarPinnedStorageValue,
	toggleCollapsedProjectIds,
	togglePinnedChatIds,
	unsentSendReturnsHere,
	visibleSidebarChats,
	withBusyChat,
	withChatSent,
	withChatTurnStatus,
	withoutBusyChat,
	withProjectExpanded,
} from "./sidebar-chats";

describe("unused chats", () => {
	const chats = [
		{ id: "draft", title: "New session", unused: true },
		{ id: "handoff", title: "Continued from Claude Code" },
		{ id: "used", title: "Fix the parser" },
	];

	it("lists a chat nothing was sent to only while it is open", () => {
		expect(
			visibleSidebarChats(chats, "handoff").map((chat) => chat.id),
		).toEqual(["handoff", "used"]);
		expect(visibleSidebarChats(chats, "draft").map((chat) => chat.id)).toEqual([
			"draft",
			"handoff",
			"used",
		]);
		expect(visibleSidebarChats(chats, undefined)).toHaveLength(2);
	});

	it("keeps a chat listed once its first message is sent", () => {
		const sent = withChatSent(chats, "draft", "Fix the build");
		expect(visibleSidebarChats(sent, "used").map((chat) => chat.id)).toEqual([
			"draft",
			"handoff",
			"used",
		]);
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
				[
					{ id: "a", title: "a" },
					{ id: "b", title: "b" },
					{ id: "c", title: "c" },
				],
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

	it("names an untitled chat after the message sent to it, before the send lands", () => {
		expect(
			withChatSent(
				[
					{ id: "a", title: "New session", turnStatus: "idle" },
					{ id: "b", title: "add snapshot copy", turnStatus: "idle" },
				],
				"a",
				"fix login\nthen run the tests",
			),
		).toEqual([
			{ id: "a", title: "fix login", turnStatus: "running" },
			{ id: "b", title: "add snapshot copy", turnStatus: "idle" },
		]);
		expect(
			withChatSent(
				[{ id: "a", title: "fix login", turnStatus: "idle" }],
				"a",
				"and the signup page",
			),
		).toEqual([{ id: "a", title: "fix login", turnStatus: "running" }]);
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
						harnessId: "api",
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
						harnessId: "api",
					},
					{ id: "b", title: "add snapshot copy" },
				],
				"a",
				"codex",
			),
		).toBe("api");
		expect(
			listedChatHarnessId(
				[{ id: "b", title: "add snapshot copy" }],
				"b",
				"api",
			),
		).toBe("api");
		expect(
			composerHarnessForChat({
				listedHarnessId: "codex",
				connectionProvider: "api",
				fallback: "api",
			}),
		).toBe("codex");
		expect(
			composerHarnessForChat({
				listedHarnessId: null,
				connectionProvider: "api",
				fallback: "codex",
			}),
		).toBe("api");
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

describe("switching projects", () => {
	it("leaves none of the previous project's chat open", () => {
		const open = {
			workspaceId: "ws-1",
			agentSessionId: "chat-1",
			selectedBranch: "feature",
			items: [
				{
					kind: "userMessage" as const,
					id: SessionItemId("m1"),
					text: "hi",
				},
			],
			turnStatus: "running" as const,
			canSend: true,
		};
		expect(sessionWithoutOpenChat(open)).toEqual({
			workspaceId: null,
			agentSessionId: null,
			selectedBranch: undefined,
			items: [],
			turnStatus: "idle",
			canSend: true,
		});
	});
});

describe("unsent sends", () => {
	it("return only to the chat that sent them", () => {
		const sent = { sentEpoch: 1, sentChatId: "a" };
		expect(
			unsentSendReturnsHere({ ...sent, currentEpoch: 1, openChatId: "a" }),
		).toBe(true);
		// Moved to chat b: b's composer keeps its own draft.
		expect(
			unsentSendReturnsHere({ ...sent, currentEpoch: 2, openChatId: "b" }),
		).toBe(false);
		// Reopened chat a: the message comes back to it.
		expect(
			unsentSendReturnsHere({ ...sent, currentEpoch: 3, openChatId: "a" }),
		).toBe(true);
		// A new-chat draft's send never lands in a newer new-chat draft.
		expect(unsentSendReturnsHere({ sentEpoch: 1, currentEpoch: 2 })).toBe(
			false,
		);
	});
});

describe("sidebar sort", () => {
	const a = { id: "a", name: "Alpha" };
	const b = { id: "b", name: "Beta" };
	const c = { id: "c", name: "Gamma" };
	const groups = [
		{
			project: a,
			chats: [
				{ id: "a1", title: "Old", updatedAt: "2026-10-01T00:00:00Z" },
				{ id: "a2", title: "Mid", updatedAt: "2026-10-10T00:00:00Z" },
			],
		},
		{
			project: b,
			chats: [{ id: "b1", title: "New", updatedAt: "2026-10-19T00:00:00Z" }],
		},
		{ project: c, chats: [] },
	];

	it("lists every chat newest first with its project, pinned on top", () => {
		expect(
			recentSidebarChats(groups).map((row) => [row.chat.id, row.project.id]),
		).toEqual([
			["b1", "b"],
			["a2", "a"],
			["a1", "a"],
		]);
		expect(
			recentSidebarChats(groups, ["a1"]).map((row) => row.chat.id),
		).toEqual(["a1", "b1", "a2"]);
	});

	it("keeps Y² chats out of the chat list and groups them by activity", () => {
		const y2 = (id: string, updatedAt: string) => ({
			id,
			title: "Y²",
			role: "y2" as const,
			updatedAt,
		});
		const mixed = [
			{
				project: a,
				chats: [
					y2("a-y2", "2026-10-20T00:00:00Z"),
					{ id: "a1", title: "Old", updatedAt: "2026-10-01T00:00:00Z" },
				],
			},
			{
				project: b,
				chats: [
					y2("b-y2", "2026-10-25T00:00:00Z"),
					{ id: "b1", title: "New", updatedAt: "2026-10-19T00:00:00Z" },
				],
			},
			{ project: c, chats: [{ id: "c1", title: "Plain" }] },
		];
		expect(
			recentY2Chats(mixed).map((row) => [row.chat.id, row.project.id]),
		).toEqual([
			["b-y2", "b"],
			["a-y2", "a"],
		]);
		expect(recentSidebarChats(mixed).map((row) => row.chat.id)).toEqual([
			"b1",
			"a1",
			"c1",
		]);
		// Pinning reorders threads only; a stale pin on a Y² id never lists it twice.
		expect(
			recentSidebarChats(mixed, ["a1", "a-y2"]).map((row) => row.chat.id),
		).toEqual(["a1", "b1", "c1"]);
		expect(recentY2Chats(groups)).toEqual([]);
	});

	it("splits Recent into Y², Y and plain: a chat is in exactly one", () => {
		const y2 = (id: string, updatedAt: string) => ({
			id,
			title: "Y²",
			role: "y2" as const,
			updatedAt,
		});
		const mixed = [
			{
				project: a,
				chats: [
					y2("a-y2", "2026-10-20T00:00:00Z"),
					{ id: "a1", title: "Old", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "a2", title: "Newer", updatedAt: "2026-10-12T00:00:00Z" },
				],
			},
			{
				project: b,
				chats: [
					y2("b-y2", "2026-10-25T00:00:00Z"),
					{ id: "b1", title: "New", updatedAt: "2026-10-19T00:00:00Z" },
				],
			},
			{
				project: c,
				chats: [
					{ id: "c1", title: "Plain", updatedAt: "2026-10-15T00:00:00Z" },
					{ id: "c2", title: "Plain old", updatedAt: "2026-10-02T00:00:00Z" },
				],
			},
		];
		const ids = (rows: { chat: { id: string } }[]) =>
			rows.map((row) => row.chat.id);
		const split = recentSections(mixed);
		expect(ids(split.y2)).toEqual(["b-y2", "a-y2"]);
		expect(ids(split.y)).toEqual(["b1", "a2", "a1"]);
		expect(ids(split.plain)).toEqual(["c1", "c2"]);
		// Pins lead within their own section only; a Y² id (stale pin) never moves.
		const pinned = recentSections(mixed, ["a1", "c2", "a-y2"]);
		expect(ids(pinned.y)).toEqual(["a1", "b1", "a2"]);
		expect(ids(pinned.plain)).toEqual(["c2", "c1"]);
		expect(ids(pinned.y2)).toEqual(["b-y2", "a-y2"]);
		// Together they are exactly recentY2Chats plus recentSidebarChats.
		expect(
			[...ids(split.y2), ...ids(split.y), ...ids(split.plain)].sort(),
		).toEqual(
			[...ids(recentY2Chats(mixed)), ...ids(recentSidebarChats(mixed))].sort(),
		);
		// Without Y everything is plain.
		const none = recentSections([mixed[2]]);
		expect(none.y2).toEqual([]);
		expect(none.y).toEqual([]);
		expect(ids(none.plain)).toEqual(["c1", "c2"]);
	});

	it("orders projects by their newest chat, empty projects last in their order", () => {
		expect(
			projectsByRecentActivity([c, a, b], groups).map((project) => project.id),
		).toEqual(["b", "a", "c"]);
	});
});

describe("chatOpenedWithProject", () => {
	it("opens the project's latest chat", () => {
		expect(
			chatOpenedWithProject({
				chats: [
					{ id: "new", title: "Fix login" },
					{ id: "old", title: "Add tests" },
				],
				composerDraft: false,
			})?.id,
		).toBe("new");
	});

	it("never opens the project's setup chat by itself", () => {
		expect(
			chatOpenedWithProject({
				chats: [
					{ id: "setup", title: "Set up project" },
					{ id: "task", title: "Fix login" },
				],
				composerDraft: false,
			})?.id,
		).toBe("task");
		expect(
			chatOpenedWithProject({
				chats: [{ id: "legacy", title: "Set up environment" }],
				composerDraft: false,
			}),
		).toBeUndefined();
	});

	it("background setup start never changes the selected chat: a new project's empty chat stays open through the whole setup", () => {
		// What the list holds as the background setup goes: created and held
		// for the build, its turn running once the build is ready, asking for a
		// secret, done. Nothing else is in the project; the new empty chat is
		// open (no chat selected), so each list arrival asks what opens.
		const setup = { id: "setup", title: "Set up project" };
		const lists: readonly SidebarChat[][] = [
			[],
			[{ ...setup, waitsForSetup: true }],
			[{ ...setup, turnStatus: "running" as const }],
			[{ ...setup, waitingOn: "secret" as const }],
			[{ ...setup, turnStatus: "completed" as const }],
		];
		for (const chats of lists)
			for (const composerDraft of [false, true])
				expect(
					chatOpenedWithProject({ chats, composerDraft }),
					JSON.stringify(chats),
				).toBeUndefined();
	});

	it("opens nothing over a new-chat draft or for a project without chats", () => {
		expect(
			chatOpenedWithProject({
				chats: [{ id: "a", title: "Fix login" }],
				composerDraft: true,
			}),
		).toBeUndefined();
		expect(
			chatOpenedWithProject({ chats: [], composerDraft: false }),
		).toBeUndefined();
		expect(
			chatOpenedWithProject({ chats: undefined, composerDraft: false }),
		).toBeUndefined();
	});
});

describe("projectsLatestChatsToReadAhead", () => {
	const projects = [
		{ projectId: "p1", chats: [{ id: "a1" }, { id: "a2" }] },
		{ projectId: "p2", chats: [{ id: "b1" }] },
		{ projectId: "p3", chats: [] },
		{ projectId: "p4", chats: [{ id: "d1" }] },
	];

	it("reads each other project's latest chat once", () => {
		expect(
			projectsLatestChatsToReadAhead({
				projects,
				openProjectId: "p1",
				heldChatIds: new Set(["d1"]),
			}),
		).toEqual(["b1"]);
	});

	it("reads every project's latest chat when none is open", () => {
		expect(
			projectsLatestChatsToReadAhead({ projects, heldChatIds: new Set() }),
		).toEqual(["a1", "b1", "d1"]);
	});
});

describe("chatsToReadAhead", () => {
	const chats = ["a", "b", "c", "d"].map((id) => ({ id }));

	it("reads the latest chats except the open one and those already held", () => {
		expect(
			chatsToReadAhead({
				chats,
				openChatId: "a",
				heldChatIds: new Set(["c"]),
			}),
		).toEqual(["b", "d"]);
	});

	it("looks only at the first few chats", () => {
		expect(
			chatsToReadAhead({ chats, heldChatIds: new Set(), limit: 2 }),
		).toEqual(["a", "b"]);
	});
});

describe("chats holding a message for setup", () => {
	it("are never hidden as unused, open or not", async () => {
		const { visibleSidebarChats, withChatHeldForSetup, sidebarStatusGroup } =
			await import("./sidebar-chats");
		const chats = [
			{ id: "held", title: "New session", unused: true, waitsForSetup: true },
			{ id: "empty", title: "New session", unused: true },
		];
		expect(
			visibleSidebarChats(chats, undefined).map((chat) => chat.id),
		).toEqual(["held"]);
		const [held] = withChatHeldForSetup(
			[{ id: "c", title: "New session", unused: true }],
			"c",
			"Add a login page",
		);
		expect(held).toMatchObject({
			title: "Add a login page",
			unused: false,
			waitsForSetup: true,
		});
		expect(held).not.toHaveProperty("turnStatus");
		expect(sidebarStatusGroup({ running: false, waitsForSetup: true })).toBe(
			"working",
		);
	});
});
