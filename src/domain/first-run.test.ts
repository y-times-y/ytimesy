import { expect, it } from "vitest";
import { firstRunStage, firstRunStep } from "./first-run";

const at = (
	githubConnected: boolean,
	repositoryCount: number | null,
	projectAdded = false,
) => firstRunStep({ githubConnected, repositoryCount, projectAdded });

it("goes GitHub, then the app install, then repositories, then the model", () => {
	expect(at(false, null)).toBe("github");
	expect(at(true, 0)).toBe("install");
	expect(at(true, 3)).toBe("repositories");
	expect(at(true, 3, true)).toBe("model");
});

it("does not ask for the install before the repository list has loaded", () => {
	expect(at(true, null)).toBe("repositories");
});

it("counts the install as part of the GitHub stage", () => {
	expect(firstRunStage("github")).toBe(0);
	expect(firstRunStage("install")).toBe(0);
	expect(firstRunStage("repositories")).toBe(1);
	expect(firstRunStage("model")).toBe(2);
});
