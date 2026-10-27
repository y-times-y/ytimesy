import { describe, expect, it } from "vitest";
import {
	agentDesktopActivityInTurn,
	desktopClientViewerUrl,
	desktopInspectorPrompt,
	desktopInspectorShouldStart,
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

describe("agentDesktopActivityInTurn", () => {
	const items = [
		{ kind: "userMessage", id: "u1" },
		{ kind: "dynamicToolCall", id: "old", tool: "browser_open" },
		{ kind: "userMessage", id: "u2" },
		{ kind: "dynamicToolCall", id: "t1", tool: "execute_command" },
		{ kind: "dynamicToolCall", id: "t2", tool: "browser_open" },
		{ kind: "dynamicToolCall", id: "t3", tool: "browser_screenshot" },
	];
	it("finds the first desktop tool call of the running turn only", () => {
		expect(agentDesktopActivityInTurn({ turnStatus: "running", items })).toBe(
			"t2",
		);
		expect(
			agentDesktopActivityInTurn({
				turnStatus: "running",
				items: items.slice(0, 4),
			}),
		).toBeNull();
	});
	it("ignores settled turns", () => {
		expect(
			agentDesktopActivityInTurn({ turnStatus: "completed", items }),
		).toBeNull();
	});
});
