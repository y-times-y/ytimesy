import { describe, expect, it } from "vitest";
import {
	desktopCanBeControlled,
	desktopHostname,
	desktopPortIsListening,
	desktopViewerUrl,
	desktopViewerUrlForMachine,
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

	it("rebuilds the same viewer URL from the durable machine id", () => {
		expect(desktopHostname("vm_abcDEF-12")).toBe(
			"ytimesy-desk-vmabcdef12.style.dev",
		);
		expect(desktopViewerUrlForMachine("vm_abcDEF-12")).toContain(
			"ytimesy-desk-vmabcdef12.style.dev/vnc.html",
		);
		expect(desktopPortIsListening("YTIMESY_DESKTOP_UP\n")).toBe(true);
		expect(desktopPortIsListening("YTIMESY_DESKTOP_DOWN\n")).toBe(false);
	});
});
