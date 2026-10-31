import { describe, expect, it } from "vitest";
import {
	desktopClientViewerUrl,
	desktopDisconnectMessage,
	desktopInspectorPrompt,
	desktopInspectorShouldStart,
	desktopSidebarShouldOpen,
	desktopUseStreakId,
} from "./workspace-desktop";

describe("workspace desktop", () => {
	it("gives the browser a same-origin desktop socket, not the host URL", () => {
		expect(
			desktopClientViewerUrl({
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).toBe("/api/desktop?projectId=project-1&sessionId=session-1");
		expect(
			desktopClientViewerUrl({
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).not.toMatch(/style\.dev|vnc\.html|novnc/i);
	});

	it("starts the desktop as soon as the Desktop tab is open on a chat", () => {
		expect(
			desktopInspectorShouldStart({
				tabActive: true,
				projectId: "project-1",
				sessionId: "session-1",
				desktop: { status: "stopped" },
				busy: false,
			}),
		).toBe(true);
		expect(
			desktopInspectorShouldStart({
				tabActive: true,
				projectId: "project-1",
				sessionId: "session-1",
				desktop: { status: "starting" },
				busy: false,
			}),
		).toBe(false);
		expect(
			desktopInspectorShouldStart({
				tabActive: true,
				projectId: "project-1",
				desktop: { status: "stopped" },
				busy: false,
			}),
		).toBe(false);
		expect(
			desktopInspectorPrompt({
				desktop: { status: "stopped" },
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).toMatchObject({
			title: "Starting desktop",
			description: null,
			actionLabel: null,
			starting: true,
			slowHint: "First start can take a minute",
		});
		expect(
			desktopInspectorPrompt({
				desktop: { status: "starting" },
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).toMatchObject({ title: "Starting desktop", starting: true });
		expect(
			desktopInspectorPrompt({
				desktop: { status: "failed", reason: "VM not found" },
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).toMatchObject({
			title: "Desktop didn't start",
			description: "VM not found",
			actionLabel: "Try again",
			starting: false,
		});
	});
});

describe("desktop sidebar auto-open", () => {
	const items = [
		{ kind: "userMessage", id: "u1" },
		{ kind: "dynamicToolCall", id: "old", tool: "browser_open" },
		{ kind: "userMessage", id: "u2" },
		{
			kind: "dynamicToolCall",
			id: "t1",
			tool: "execute_command",
			input: JSON.stringify({ command: "npm test" }),
		},
		{ kind: "dynamicToolCall", id: "t2", tool: "browser_open" },
		{ kind: "reasoning", id: "r1" },
		{ kind: "dynamicToolCall", id: "t3", tool: "browser_screenshot" },
	];
	it("starts a streak at the first desktop call of the running turn", () => {
		expect(desktopUseStreakId({ turnStatus: "running", items })).toBe("t2");
		expect(
			desktopUseStreakId({
				turnStatus: "running",
				items: items.slice(0, 4),
			}),
		).toBeNull();
	});
	it("keeps the same streak across later screenshots and frames", () => {
		expect(desktopUseStreakId({ turnStatus: "running", items })).toBe("t2");
		expect(
			desktopSidebarShouldOpen({
				streakId: "t2",
				dismissedStreakId: "t2",
			}),
		).toBe(false);
		expect(
			desktopSidebarShouldOpen({
				streakId: "t2",
				dismissedStreakId: null,
			}),
		).toBe(true);
	});
	it("opens again only after the desktop goes idle and a later streak starts", () => {
		const idle = [
			...items,
			{ kind: "fileChange", id: "edit" },
			{
				kind: "dynamicToolCall",
				id: "shell",
				tool: "bash",
				input: JSON.stringify({ command: "git status" }),
			},
		];
		expect(
			desktopUseStreakId({ turnStatus: "running", items: idle }),
		).toBeNull();
		expect(
			desktopSidebarShouldOpen({
				streakId: null,
				dismissedStreakId: "t2",
			}),
		).toBe(false);
		const again = [
			...idle,
			{ kind: "reasoning", id: "r2" },
			{
				kind: "dynamicToolCall",
				id: "t4",
				tool: "computer_use",
			},
			{
				kind: "dynamicToolCall",
				id: "t5",
				tool: "view_image",
				input: JSON.stringify({ path: "/tmp/ytimesy-screenshot-1.png" }),
			},
		];
		expect(desktopUseStreakId({ turnStatus: "running", items: again })).toBe(
			"t4",
		);
		expect(
			desktopSidebarShouldOpen({
				streakId: "t4",
				dismissedStreakId: "t2",
			}),
		).toBe(true);
	});
	it("treats desktop shell commands and screenshots as the same streak", () => {
		const shell = [
			{ kind: "userMessage", id: "u" },
			{
				kind: "dynamicToolCall",
				id: "open",
				tool: "exec_command",
				input: JSON.stringify({
					cmd: "ytimesy-browser open http://localhost:3000",
				}),
			},
			{
				kind: "commandExecution",
				id: "shot",
				command: "DISPLAY=:0 scrot -o /tmp/ytimesy-screenshot-2.png",
			},
			{
				kind: "dynamicToolCall",
				id: "look",
				tool: "Read",
				input: "src/app.tsx",
			},
		];
		expect(desktopUseStreakId({ turnStatus: "running", items: shell })).toBe(
			"open",
		);
		expect(
			desktopUseStreakId({
				turnStatus: "running",
				items: [
					{
						kind: "dynamicToolCall",
						id: "png",
						tool: "view_image",
						input: "assets/logo.png",
					},
				],
			}),
		).toBeNull();
	});
	it("ignores settled turns", () => {
		expect(desktopUseStreakId({ turnStatus: "completed", items })).toBeNull();
		expect(
			desktopSidebarShouldOpen({
				streakId: null,
				dismissedStreakId: null,
			}),
		).toBe(false);
	});
});

describe("desktopDisconnectMessage", () => {
	it("shows the server's close reason when the relay gave one", () => {
		expect(
			desktopDisconnectMessage({
				reason: " Desktop is not ready. ",
				connected: false,
				clean: false,
			}),
		).toBe("Desktop is not ready.");
	});
	it("says the desktop never answered when it closed before connecting", () => {
		expect(desktopDisconnectMessage({ connected: false, clean: false })).toBe(
			"The desktop didn't answer.",
		);
	});
	it("tells a lost connection from a closed one", () => {
		expect(desktopDisconnectMessage({ connected: true, clean: false })).toBe(
			"The desktop connection was lost.",
		);
		expect(desktopDisconnectMessage({ connected: true, clean: true })).toBe(
			"The desktop connection closed.",
		);
	});
});
