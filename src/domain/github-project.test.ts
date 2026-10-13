import { describe, expect, it } from "vitest";
import { gitHubRepositoryFromApi } from "./github-project";

const ytimesy = {
	owner: "y-times-y",
	name: "ytimesy",
	fullName: "y-times-y/ytimesy",
	defaultBranch: "master",
	private: true,
	installationId: "161432829",
};

describe("gitHubRepositoryFromApi", () => {
	it("reads an installation repository payload", () => {
		expect(
			gitHubRepositoryFromApi("161432829", {
				name: "ytimesy",
				full_name: "y-times-y/ytimesy",
				default_branch: "master",
				private: true,
				owner: { login: "y-times-y" },
			}),
		).toEqual(ytimesy);
	});

	it("drops incomplete payloads instead of fabricating a repo", () => {
		expect(gitHubRepositoryFromApi("1", { name: "ytimesy" })).toBeNull();
		expect(gitHubRepositoryFromApi(" ", ytimesy)).toBeNull();
	});
});
