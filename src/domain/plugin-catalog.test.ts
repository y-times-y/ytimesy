import { expect, it } from "vitest";
import { PLUGIN_CATALOG } from "./plugin-catalog";

it("pins every reviewed plugin to a full commit with a safe source and unique id", () => {
	expect(PLUGIN_CATALOG.length).toBeGreaterThan(0);
	const ids = new Set<string>();
	for (const entry of PLUGIN_CATALOG) {
		expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
		expect(entry.sha).toMatch(/^[a-f0-9]{40}$/);
		expect(entry.owner).toMatch(/^[A-Za-z0-9-]{1,39}$/);
		expect(entry.repo).toMatch(/^[A-Za-z0-9._-]{1,100}$/);
		expect(entry.path.split("/")).not.toContain("..");
		expect(ids.has(entry.id)).toBe(false);
		ids.add(entry.id);
	}
	expect(
		PLUGIN_CATALOG.find((entry) => entry.id === "github")?.settings,
	).toEqual([
		expect.objectContaining({
			key: "GITHUB_PERSONAL_ACCESS_TOKEN",
			sensitive: true,
		}),
	]);
});

it("describes plugins in ytimesy's words, not another agent's", () => {
	for (const entry of PLUGIN_CATALOG) {
		expect(entry.description).not.toMatch(
			/\bClaude\b|\bCodex CLI\b|\bCursor\b/,
		);
		expect(entry.description).not.toMatch(/…$/);
	}
});
