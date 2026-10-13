import { describe, expect, it } from "vitest";
import {
	SHARED_DISPLAY,
	sharedDesktopDeveloperInstructions,
	visualQaInstructions,
} from "./agent-desktop";

describe("sharedDesktopDeveloperInstructions", () => {
	it("tells the agent to QA on the shared display the user is watching", () => {
		const text = sharedDesktopDeveloperInstructions({
			cwd: "/home/ubuntu/ytimesy",
		});
		expect(text).toContain("/home/ubuntu/ytimesy");
		expect(text).toContain(`DISPLAY=${SHARED_DISPLAY}`);
		expect(text).toContain("Desktop tab");
		expect(text).toContain("google-chrome-stable");
		expect(text).toContain("chromium");
		expect(text).toContain("Connect starts that display");
		expect(text).toContain("xdotool");
		expect(text).toContain("scrot");
		expect(text).toContain("computer-use");
		expect(
			sharedDesktopDeveloperInstructions({
				cwd: "/home/ubuntu/ytimesy",
				secretNames: ["GH_TOKEN"],
			}),
		).toContain("GH_TOKEN");
	});
});

describe("visualQaInstructions", () => {
	it("says when to check the UI and asks for screenshot evidence in the report", () => {
		for (const via of ["tools", "shell"] as const) {
			const text = visualQaInstructions(via);
			expect(text).toContain("affects what a user sees");
			expect(text).toContain("before reporting done");
			expect(text).toContain("what the screenshot showed");
		}
		expect(visualQaInstructions("tools")).toContain("browser_screenshot");
		expect(visualQaInstructions("shell")).toContain("scrot");
		expect(
			sharedDesktopDeveloperInstructions({ cwd: "/home/ubuntu/ytimesy" }),
		).toContain(visualQaInstructions("shell"));
	});
});
