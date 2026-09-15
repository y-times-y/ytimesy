import { describe, expect, it } from "vitest";
import {
	SHARED_DISPLAY,
	sharedDesktopDeveloperInstructions,
} from "./agent-desktop";

describe("sharedDesktopDeveloperInstructions", () => {
	it("tells the agent to QA on the shared display the user is watching", () => {
		const text = sharedDesktopDeveloperInstructions({
			cwd: "/home/ubuntu/ytimesy",
		});
		expect(text).toContain("/home/ubuntu/ytimesy");
		expect(text).toContain(`DISPLAY=${SHARED_DISPLAY}`);
		expect(text).toContain("Desktop tab");
		expect(text).toContain("chromium");
		expect(text).toContain("xdotool");
		expect(text).toContain("scrot");
		expect(text).not.toContain("Start desktop");
	});
});
