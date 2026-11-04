import { describe, expect, it } from "vitest";
import {
	clampPtySize,
	parseTerminalClientMessage,
	terminalClosedMessage,
	terminalConnectBlockedReason,
	terminalInspectorPrompt,
	terminalInspectorShouldAttach,
	terminalSessionBlockedReason,
	workspacePtyCommand,
} from "./workspace-terminal";

describe("workspace terminal", () => {
	it("clamps PTY dimensions and parses resize frames", () => {
		expect(clampPtySize(0, 0)).toEqual({ cols: 80, rows: 24 });
		expect(clampPtySize(10, 4)).toEqual({ cols: 20, rows: 8 });
		expect(clampPtySize(400, 200)).toEqual({ cols: 300, rows: 100 });
		expect(
			parseTerminalClientMessage('{"type":"resize","cols":120,"rows":32}'),
		).toEqual({
			type: "resize",
			cols: 120,
			rows: 32,
		});
		expect(parseTerminalClientMessage("not-json")).toBeNull();
		expect(parseTerminalClientMessage('{"type":"signal"}')).toBeNull();
	});

	it("blocks the terminal until a prepared machine exists", () => {
		expect(terminalConnectBlockedReason(null)).toMatch(/Prepare a workspace/);
		expect(
			terminalConnectBlockedReason({
				status: "cloning",
				providerRef: "vm-1",
			}),
		).toMatch(/Wait for workspace preparation/);
		expect(
			terminalConnectBlockedReason({
				status: "ready",
				providerRef: "vm-1",
			}),
		).toBeNull();
		expect(
			terminalConnectBlockedReason({
				status: "ready",
				providerRef: null,
				templateSnapshotId: "sh-template",
			}),
		).toBeNull();
	});

	it("opens a chat's own machine while the project is still being set up", () => {
		expect(
			terminalConnectBlockedReason(
				{ status: "cloning", providerRef: null },
				"vm-chat",
			),
		).toBeNull();
		expect(
			terminalConnectBlockedReason(
				{ status: "failed", providerRef: null },
				null,
			),
		).toMatch(/failed/);
	});

	it("does not open a terminal on the unused template", () => {
		expect(terminalSessionBlockedReason("vm-agent")).toBeNull();
		expect(terminalSessionBlockedReason(null)).toMatch(/Connect an agent/);
	});

	it("attaches the PTY as soon as the Terminal tab is open on a chat", () => {
		expect(
			terminalInspectorShouldAttach({
				tabActive: true,
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).toBe(true);
		expect(
			terminalInspectorShouldAttach({
				tabActive: false,
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).toBe(false);
		expect(
			terminalInspectorShouldAttach({
				tabActive: true,
				projectId: "project-1",
			}),
		).toBe(false);
		expect(terminalInspectorPrompt({ projectId: "project-1" })).toMatchObject({
			description: "Connect an agent before opening the terminal.",
		});
		expect(
			terminalInspectorPrompt({
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).toMatchObject({
			title: "Starting terminal…",
		});
	});

	it("starts the shell in the cloned repository directory as ytimesy", () => {
		expect(workspacePtyCommand("/home/ubuntu/ytimesy")).toContain(
			"cd '/home/ubuntu/ytimesy'",
		);
		expect(workspacePtyCommand("/home/ubuntu/ytimesy")).toContain(
			"HOSTNAME=ytimesy",
		);
		expect(workspacePtyCommand("/home/ubuntu/ytimesy")).not.toContain(
			"freestyle",
		);
	});
});

it("explains a terminal socket that closed without an error message", () => {
	expect(terminalClosedMessage({ wasClean: true })).toBe("Terminal closed.");
	expect(terminalClosedMessage({ reason: " ", wasClean: false })).toBe(
		"Terminal disconnected.",
	);
	expect(
		terminalClosedMessage({ reason: "Workspace stopped.", wasClean: true }),
	).toBe("Workspace stopped.");
});
