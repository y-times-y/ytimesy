import { describe, expect, it } from "vitest";
import { desktopCanBeControlled, desktopViewerUrl } from "./workspace-desktop";

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
});
