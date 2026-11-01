import { expect, it } from "vitest";
import { composerProjectNotice, NO_PROJECT_NOTICE } from "./composer-project";

it("holds a send without a project and says to choose a repository", () => {
	expect(composerProjectNotice({})).toBe(NO_PROJECT_NOTICE);
	expect(composerProjectNotice({ selectedProjectId: "" })).toBe(
		NO_PROJECT_NOTICE,
	);
	expect(composerProjectNotice({ selectedProjectId: "p1" })).toBeNull();
});
