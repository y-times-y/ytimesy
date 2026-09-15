import { describe, expect, it } from "vitest";
import {
	clampPtySize,
	isWorkspacePtySlug,
	parseTerminalClientMessage,
	terminalConnectBlockedReason,
	WORKSPACE_PTY_SLUG,
	workspacePtyCommand,
} from "./workspace-terminal";

describe("workspace terminal", () => {
	it("names the reconnectable PTY with a stable slug", () => {
		expect(isWorkspacePtySlug(WORKSPACE_PTY_SLUG)).toBe(true);
		expect(WORKSPACE_PTY_SLUG).toBe("main");
		expect(isWorkspacePtySlug("12345")).toBe(false);
		expect(isWorkspacePtySlug("Main")).toBe(false);
	});

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
	});

	it("starts the shell in the cloned repository directory", () => {
		expect(workspacePtyCommand("/home/ubuntu/ytimesy")).toBe(
			"cd '/home/ubuntu/ytimesy' && exec bash -l",
		);
	});
});
