import { describe, expect, it } from "vitest";
import {
	desktopCanBeControlled,
	desktopClientViewerUrl,
	desktopFailedBecauseWorkspaceGone,
	desktopHostname,
	desktopInspectorPrompt,
	desktopInspectorShouldStart,
	desktopPortIsListening,
	desktopStartFailureReason,
	desktopViewerUrl,
	desktopViewerUrlForMachine,
	START_HARNESS_BEFORE_DESKTOP,
} from "./workspace-desktop";

describe("workspace desktop", () => {
	it("is controllable only when a viewer URL is running", () => {
		expect(desktopViewerUrl({ status: "stopped" })).toBeNull();
		expect(
			desktopCanBeControlled({
				status: "running",
				viewerUrl: "/api/desktop?projectId=project-1&sessionId=session-1",
				display: ":0",
				message: null,
			}),
		).toBe(true);
		expect(
			desktopCanBeControlled({
				status: "running",
				viewerUrl: null,
				display: ":0",
				message: "VNC is up but not exposed",
			}),
		).toBe(false);
	});

	it("asks to start a harness when the proof VM is gone", () => {
		const cause = {
			message: "An unknown error occurred in Effect.tryPromise",
			error: { message: "VM not found" },
		};
		expect(desktopFailedBecauseWorkspaceGone(cause)).toBe(true);
		expect(desktopStartFailureReason(cause)).toBe(START_HARNESS_BEFORE_DESKTOP);
	});

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

	it("keeps the remote host name on the server", () => {
		expect(desktopHostname("vm_abcDEF-12")).toBe(
			"ytimesy-desk-vmabcdef12.style.dev",
		);
		expect(desktopViewerUrlForMachine("vm_abcDEF-12")).toBe(
			"https://ytimesy-desk-vmabcdef12.style.dev/",
		);
		expect(desktopPortIsListening("YTIMESY_DESKTOP_UP\n")).toBe(true);
		expect(desktopPortIsListening("YTIMESY_DESKTOP_DOWN\n")).toBe(false);
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
			title: "Starting desktop…",
			actionLabel: null,
		});
		expect(
			desktopInspectorPrompt({
				desktop: { status: "failed", reason: "VM not found" },
				projectId: "project-1",
				sessionId: "session-1",
			}),
		).toMatchObject({
			actionLabel: "Retry desktop",
		});
	});
});
