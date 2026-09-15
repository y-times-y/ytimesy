import { describe, expect, it } from "vitest";
import {
	desktopCanBeControlled,
	desktopEmbedUrl,
	desktopFailedBecauseWorkspaceGone,
	desktopStartFailureReason,
	desktopViewerUrl,
	START_HARNESS_BEFORE_DESKTOP,
} from "./workspace-desktop";

describe("workspace desktop", () => {
	it("is controllable only when a viewer URL is running", () => {
		expect(desktopViewerUrl({ status: "stopped" })).toBeNull();
		expect(
			desktopCanBeControlled({
				status: "running",
				viewerUrl: "https://desk.style.dev/vnc.html",
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

	it("embeds noVNC without local letterboxing inside the iframe", () => {
		expect(desktopEmbedUrl("https://ytimesy-desk-abc.style.dev")).toBe(
			"https://ytimesy-desk-abc.style.dev/vnc.html?autoconnect=1&resize=off&reconnect=1",
		);
	});
});
