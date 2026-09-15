import { describe, expect, it } from "vitest";
import { START_WORKSPACE_DESKTOP } from "./start-desktop";

describe("start workspace desktop", () => {
	it("uses passwordless sudo for apt when the guest is not root", () => {
		expect(START_WORKSPACE_DESKTOP).toContain("sudo -n apt-get");
		expect(START_WORKSPACE_DESKTOP).toContain("id -u");
		expect(START_WORKSPACE_DESKTOP).toContain("chromium");
		expect(START_WORKSPACE_DESKTOP).toContain("xdotool");
		expect(START_WORKSPACE_DESKTOP).toContain("export DISPLAY=:0");
		expect(START_WORKSPACE_DESKTOP).toContain("--no-sandbox");
		expect(START_WORKSPACE_DESKTOP).toContain("about:blank");
	});
});
