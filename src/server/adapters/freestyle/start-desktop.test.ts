import { describe, expect, it } from "vitest";
import { chromeOpenCommand } from "#/server/services/api-agent-browser-tools";
import { browserUseSetup } from "../browser-use-cli";
import {
	DESKTOP_X_ENVIRONMENT,
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

	it("waits for the dpkg lock and finishes foreground installs before Chrome's", () => {
		expect(START_WORKSPACE_DESKTOP).toContain(
			"sudo -n apt-get -o DPkg::Lock::Timeout=180",
		);
		const chromeStarts = START_WORKSPACE_DESKTOP.indexOf(
			") >/tmp/ytimesy-chrome-install.log 2>&1 &",
		);
		expect(chromeStarts).toBeGreaterThan(0);
		const lastForegroundInstall =
			START_WORKSPACE_DESKTOP.lastIndexOf("apt_get install");
		expect(lastForegroundInstall).toBeLessThan(chromeStarts);
		expect(START_WORKSPACE_DESKTOP.indexOf("x11-xserver-utils")).toBeLessThan(
			chromeStarts,
		);
	});

	it("makes the guest name resolve before setting it", () => {
		const hostsEntry = START_WORKSPACE_DESKTOP.indexOf(
			"sudo -n tee -a /etc/hosts",
		);
		expect(hostsEntry).toBeGreaterThan(0);
		expect(hostsEntry).toBeLessThan(
			START_WORKSPACE_DESKTOP.indexOf("sudo -n hostname ytimesy"),
		);
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

	it("keeps the display, viewer and its credential from other users on the VM", () => {
		expect(START_WORKSPACE_DESKTOP).not.toMatch(/Xvfb :0 -screen[^\n]*-ac/);
		expect(START_WORKSPACE_DESKTOP).toContain(
			'Xvfb :0 -screen 0 1440x900x24 -auth "$XAUTH" -nolisten tcp',
		);
		expect(START_WORKSPACE_DESKTOP).toContain('xauth -q -f "$XAUTH" source -');
		expect(START_WORKSPACE_DESKTOP).toContain(
			'-unixsock "$VNC_SOCKET" -rfbport 0',
		);
		expect(START_WORKSPACE_DESKTOP).not.toContain("-rfbport 5900 >");
		expect(START_WORKSPACE_DESKTOP).toContain('install -d -m 0700 "$VNC_DIR"');
		expect(START_WORKSPACE_DESKTOP).not.toContain('$(cat "$DESK_AUTH_FILE")');
	});

	it("keeps Chrome and the builder's X clients working across the locked-down restart", () => {
		// Chrome is closed before its display and reopened on the new one.
		const restart = START_WORKSPACE_DESKTOP.indexOf(
			"pgrep -f '[X]vfb :0 .*-ac'",
		);
		const closeChrome = START_WORKSPACE_DESKTOP.indexOf(
			"pkill -TERM -x 'chrome|chromium|chromium-browse'",
		);
		const killX = START_WORKSPACE_DESKTOP.indexOf("pkill -x Xvfb");
		expect(restart).toBeGreaterThan(0);
		expect(closeChrome).toBeGreaterThan(restart);
		expect(killX).toBeGreaterThan(closeChrome);
		expect(START_WORKSPACE_DESKTOP).toMatch(
			/CHROME_REOPEN" = 1 \] && ! pgrep -x[^\n]*\n\s*nohup "\$\(find_chrome_bin\)"[^\n]*--restore-last-session[^\n]*--user-data-dir=\/tmp\/ytimesy-chrome-profile/,
		);
		// The cookie lives at a fixed path, so clients without HOME find it,
		// and the builder's uid reaches the display without it.
		expect(START_WORKSPACE_DESKTOP).toContain(
			"XAUTH=/tmp/ytimesy-desktop-private/Xauthority",
		);
		expect(START_WORKSPACE_DESKTOP).toContain(
			'xhost "+SI:localuser:$(id -un)"',
		);
		expect(ENSURE_WORKSPACE_DESKTOP).toContain(DESKTOP_X_ENVIRONMENT);
		expect(chromeOpenCommand("'https://example.com'")).toContain(
			DESKTOP_X_ENVIRONMENT,
		);
		expect(browserUseSetup("s")).toContain(DESKTOP_X_ENVIRONMENT);
	});

	it("can add the dock to a desktop that is already running", () => {
		expect(ENSURE_WORKSPACE_DESKTOP).toContain("hostname ytimesy");
		expect(ENSURE_WORKSPACE_DESKTOP).toContain("tint2");
		expect(ENSURE_WORKSPACE_DESKTOP).toContain("pcmanfm");
		expect(ENSURE_WORKSPACE_DESKTOP).toContain("chrome.desktop");
	});
});
