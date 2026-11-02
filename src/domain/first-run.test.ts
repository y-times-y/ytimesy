import { expect, it } from "vitest";
import {
	FIRST_RUN_STAGES,
	firstRunDoneCookie,
	firstRunDoneFromCookies,
	firstRunStage,
	firstRunStep,
} from "./first-run";

const at = (
	githubConnected: boolean,
	repositoryCount: number | null,
	modelDone = false,
	sessionsDone = false,
) =>
	firstRunStep({ githubConnected, repositoryCount, modelDone, sessionsDone });

it("goes GitHub, then the app install, then the model, then sessions, then privacy", () => {
	expect(at(false, null)).toBe("github");
	expect(at(true, 0)).toBe("install");
	expect(at(true, 3)).toBe("model");
	expect(at(true, 3, true)).toBe("sessions");
	expect(at(true, 3, true, true)).toBe("privacy");
	// The privacy card never comes before the earlier steps.
	expect(at(true, 3, false, true)).toBe("model");
});

it("needs no project: the composer's picker adds the first one", () => {
	// Nothing about projects is asked; a reachable repository is enough.
	expect(at(true, 1, true)).toBe("sessions");
});

it("offers agent sessions only with GitHub and the app reaching a repository", () => {
	expect(at(false, null, true)).toBe("github");
	expect(at(true, 0, true)).toBe("install");
});

it("does not ask for the install before the repository list has loaded", () => {
	expect(at(true, null)).toBe("github");
});

it("shows four stages and counts the install as part of GitHub", () => {
	expect(FIRST_RUN_STAGES).toEqual(["github", "model", "sessions", "privacy"]);
	expect(firstRunStage("github")).toBe(0);
	expect(firstRunStage("install")).toBe(0);
	expect(firstRunStage("model")).toBe(1);
	expect(firstRunStage("sessions")).toBe(2);
	expect(firstRunStage("privacy")).toBe(3);
});

it("remembers a finished first run per user, so it does not loop back", () => {
	const cookie = firstRunDoneCookie("user-1").split(";")[0];
	expect(firstRunDoneFromCookies(`a=1; ${cookie}; b=2`, "user-1")).toBe(true);
	expect(firstRunDoneFromCookies(cookie, "user-2")).toBe(false);
	expect(firstRunDoneFromCookies(null, "user-1")).toBe(false);
	expect(firstRunDoneFromCookies("ytimesy-setup-done=%E0%A4%A", "x")).toBe(
		false,
	);
	expect(firstRunDoneCookie("user-1")).toContain("path=/");
});
