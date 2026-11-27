import { expect, it } from "vitest";
import { elapsedText, preparingWorkspaceText } from "./template-rebuild";

it("shows stage and elapsed time in calm words", () => {
	const text = preparingWorkspaceText({
		stage: "Installing",
		elapsedMs: 83_000,
	});
	expect(text).toContain("Preparing your workspace…");
	expect(text).toContain("Installing · 1 min 23 s");
	expect(text).not.toMatch(/error|fail|404|retry/i);
	expect(preparingWorkspaceText({})).toContain("Preparing your workspace…");
	expect(elapsedText(5_000)).toBe("5 s");
});
