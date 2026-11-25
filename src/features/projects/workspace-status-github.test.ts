import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the connect prompt visible on phones: needs-GitHub shows in the setup card, an alert that is not hidden with the quiet status lines", () => {
	const status = readFileSync(
		"src/features/projects/workspace-status.tsx",
		"utf8",
	);
	const card = readFileSync("src/features/projects/setup-card.tsx", "utf8");
	const css = readFileSync("src/styles.css", "utf8");
	expect(status).toContain("<GithubSetupStep");
	expect(card).toContain('role={alert ? "alert" : "status"}');
	// The phone rule hides only `.workspace-status` lines without role=alert; the card is not one.
	expect(card).not.toContain("workspace-status ");
	expect(css).not.toMatch(/\.setup-card[^{]*\{[^}]*display:\s*none/);
});
