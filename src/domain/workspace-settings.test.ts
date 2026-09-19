import { describe, expect, it } from "vitest";
import {
	accountDisplayName,
	accountInitials,
	githubConnectionCopy,
	harnessSettingsCopy,
	settingsNavItems,
} from "./workspace-settings";

describe("workspace settings", () => {
	it("lists the essential settings sections", () => {
		expect(settingsNavItems().map((item) => item.id)).toEqual([
			"account",
			"github",
			"project",
			"agents",
		]);
	});

	it("derives a display name and initials from the signed-in user", () => {
		expect(
			accountDisplayName({ name: "Het Patel", email: "het@example.test" }),
		).toBe("Het Patel");
		expect(
			accountInitials({ name: "Het Patel", email: "het@example.test" }),
		).toBe("HP");
		expect(accountDisplayName({ name: "  ", email: "het@example.test" })).toBe(
			"het",
		);
	});

	it("does not invent a signed-in harness from a missing account", () => {
		expect(
			harnessSettingsCopy({ id: "opencode", account: { status: "disconnected" } }),
		).toMatch(/composer/);
		expect(
			harnessSettingsCopy({
				id: "codex",
				account: {
					status: "connected",
					provider: "codex",
					planType: "plus",
					email: "het@openai.test",
				},
			}),
		).toMatch(/het@openai.test/);
		expect(githubConnectionCopy(false)).toMatch(/Connect GitHub/);
	});
});
