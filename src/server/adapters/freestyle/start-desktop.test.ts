import { describe, expect, it } from "vitest";
import {
	ENSURE_WORKSPACE_DESKTOP,
	START_WORKSPACE_DESKTOP,
} from "./start-desktop";

describe("start workspace desktop", () => {
	it("uses passwordless sudo for apt when the guest is not root", () => {
		expect(START_WORKSPACE_DESKTOP).toContain("sudo -n apt-get");
		expect(START_WORKSPACE_DESKTOP).toContain("id -u");
		expect(START_WORKSPACE_DESKTOP).toContain("export DISPLAY=:0");
		expect(START_WORKSPACE_DESKTOP).toContain("--no-sandbox");
	});

	it("installs Chrome, wallpaper, and a dock with Chrome, Terminal, and Files", () => {
		expect(START_WORKSPACE_DESKTOP).toContain("google-chrome-stable");
		expect(START_WORKSPACE_DESKTOP).toContain(
			"dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb",
		);
		expect(START_WORKSPACE_DESKTOP).toContain("feh --bg-fill");
		expect(START_WORKSPACE_DESKTOP).toContain(
			"/tmp/ytimesy-desktop-wallpaper.b64",
		);
		expect(START_WORKSPACE_DESKTOP).toContain("desktop-wallpaper.png");
		expect(START_WORKSPACE_DESKTOP).toContain("tint2");
		expect(START_WORKSPACE_DESKTOP).toContain("panel_size = 0 64");
		expect(START_WORKSPACE_DESKTOP).toContain("bottom center horizontal");
		expect(START_WORKSPACE_DESKTOP).not.toContain("panel_size = 100%");
		expect(START_WORKSPACE_DESKTOP).toContain("pcmanfm");
		expect(START_WORKSPACE_DESKTOP).toContain("chrome.desktop");
		expect(START_WORKSPACE_DESKTOP).toContain("terminal.desktop");
		expect(START_WORKSPACE_DESKTOP).toContain("files.desktop");
		expect(START_WORKSPACE_DESKTOP).toContain("hostname ytimesy");
		expect(START_WORKSPACE_DESKTOP).toContain("DISABLE_UPDATES=1");
		expect(START_WORKSPACE_DESKTOP).toContain(
			"OPENCODE_DISABLE_AUTOUPDATE=true",
		);
		expect(START_WORKSPACE_DESKTOP).not.toContain("about:blank");
		expect(START_WORKSPACE_DESKTOP).not.toContain("--window-size=720,640");
		expect(START_WORKSPACE_DESKTOP).not.toContain("novnc");
		expect(START_WORKSPACE_DESKTOP).toContain(
			"Chrome is still installing; desktop is up on DISPLAY=:0",
		);
	});

	it("can add the dock to a desktop that is already running", () => {
		expect(ENSURE_WORKSPACE_DESKTOP).toContain("hostname ytimesy");
		expect(ENSURE_WORKSPACE_DESKTOP).toContain("tint2");
		expect(ENSURE_WORKSPACE_DESKTOP).toContain("pcmanfm");
		expect(ENSURE_WORKSPACE_DESKTOP).toContain("chrome.desktop");
	});
});
