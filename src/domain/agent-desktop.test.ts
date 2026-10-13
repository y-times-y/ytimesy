import { expect, it } from "vitest";
import { visualQaInstructions } from "./agent-desktop";

it("says when to check the UI and asks for screenshot evidence in the report", () => {
	const text = visualQaInstructions();
	expect(text).toContain("affects what a user sees");
	expect(text).toContain("before reporting done");
	expect(text).toContain("what the screenshot showed");
	expect(text).toContain("browser_screenshot");
	expect(text).toContain("browser_execute");
	expect(text).toContain("xdotool");
});
