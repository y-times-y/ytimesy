import { describe, expect, it } from "vitest";
import { START_WORKSPACE_DESKTOP } from "./start-desktop";

describe("start workspace desktop", () => {
	it("uses passwordless sudo for apt when the guest is not root", () => {
		expect(START_WORKSPACE_DESKTOP).toContain("sudo -n apt-get");
		expect(START_WORKSPACE_DESKTOP).toContain("id -u");
		expect(START_WORKSPACE_DESKTOP).toContain("xdotool");
		expect(START_WORKSPACE_DESKTOP).toContain("export DISPLAY=:0");
		expect(START_WORKSPACE_DESKTOP).toContain("--no-sandbox");
		expect(START_WORKSPACE_DESKTOP).toContain("about:blank");
	});

	it("installs Google Chrome, applies the ytimesy wallpaper, and opens a windowed browser", () => {
		expect(START_WORKSPACE_DESKTOP).toContain("google-chrome-stable");
		expect(START_WORKSPACE_DESKTOP).toContain(
			"dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb",
		);
		expect(START_WORKSPACE_DESKTOP).toContain("feh --bg-fill");
		expect(START_WORKSPACE_DESKTOP).toContain(
			"/tmp/ytimesy-desktop-wallpaper.b64",
		);
		expect(START_WORKSPACE_DESKTOP).toContain("desktop-wallpaper.png");
		expect(START_WORKSPACE_DESKTOP).toContain("--window-size=720,640");
		expect(START_WORKSPACE_DESKTOP).toContain("windowmove");
		expect(START_WORKSPACE_DESKTOP).toContain("pgrep -x chrome");
		expect(START_WORKSPACE_DESKTOP).not.toContain(
			"pgrep -f 'google-chrome|chromium'",
		);
		expect(START_WORKSPACE_DESKTOP).toContain(
			"Chrome is required on the shared desktop but was not installed.",
		);
	});
});
