import { expect, it } from "vitest";
import {
	ENVIRONMENT_SETUP_PROMPT,
	ENVIRONMENT_SETUP_TITLE,
	isEnvironmentSetupPrompt,
} from "./environment-setup";
import {
	environmentRecipe,
	unverifiedItemDetails,
} from "./project-environment";
import { sessionTitleFromText } from "./session-item";

it("saves what was verified instead of waiting for everything to work", () => {
	expect(ENVIRONMENT_SETUP_PROMPT).not.toMatch(/when everything works/i);
	expect(ENVIRONMENT_SETUP_PROMPT).toContain("save_project_environment");
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(/unverified/);
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(/optional runtime services/);
});

it("asks for secrets only when install or build needs them", () => {
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(
		/install or build needs a secret, ask me for it with request_project_secret/,
	);
});

it("restores regenerated tracked files and checks git status before claiming nothing changed", () => {
	expect(ENVIRONMENT_SETUP_PROMPT).toContain("git status --porcelain");
	expect(ENVIRONMENT_SETUP_PROMPT).toContain("git restore");
	expect(ENVIRONMENT_SETUP_PROMPT).toMatch(
		/only say nothing changed after git status --porcelain prints nothing/,
	);
});

it("recognizes the chip's request, unedited, and titles its chat", () => {
	expect(isEnvironmentSetupPrompt(`  ${ENVIRONMENT_SETUP_PROMPT}\n`)).toBe(
		true,
	);
	expect(isEnvironmentSetupPrompt("Set up this project's environment.")).toBe(
		false,
	);
	expect(sessionTitleFromText(ENVIRONMENT_SETUP_PROMPT)).toBe(
		ENVIRONMENT_SETUP_TITLE,
	);
	expect(ENVIRONMENT_SETUP_TITLE).toBe("Set up environment");
	expect(sessionTitleFromText("Fix the parser")).toBe("Fix the parser");
});

it("keeps unverified items on a recipe and leaves older recipes without them", () => {
	const recipe = environmentRecipe.parse({
		install: "pnpm install",
		unverified: [
			{
				what: "Dev server",
				reason: "Needs the realtime secret to start.",
				secrets: ["REALTIME_KEY"],
			},
		],
	});
	expect(recipe.unverified).toHaveLength(1);
	expect(unverifiedItemDetails(recipe.unverified?.[0] as never)).toBe(
		"Needs the realtime secret to start. Needs REALTIME_KEY.",
	);
	expect(
		environmentRecipe.parse({ install: "pnpm install" }),
	).not.toHaveProperty("unverified");
	expect(
		environmentRecipe.safeParse({
			unverified: [{ what: "Dev server", reason: "x", secrets: ["bad name"] }],
		}).success,
	).toBe(false);
});
