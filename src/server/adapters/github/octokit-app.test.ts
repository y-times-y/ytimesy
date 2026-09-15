import { describe, expect, it } from "vitest";
import {
	flattenBranchNames,
	flattenInstallationRepositories,
} from "./octokit-app";

describe("flattenInstallationRepositories", () => {
	it("keeps a paginated repository array", () => {
		expect(
			flattenInstallationRepositories([{ full_name: "y-times-y/ytimesy" }]),
		).toEqual([{ full_name: "y-times-y/ytimesy" }]);
	});

	it("unwraps the installation repositories envelope", () => {
		expect(
			flattenInstallationRepositories([
				{
					total_count: 1,
					repositories: [{ full_name: "y-times-y/ytimesy" }],
				},
			]),
		).toEqual([{ full_name: "y-times-y/ytimesy" }]);
	});
});

describe("flattenBranchNames", () => {
	it("reads branch names and ignores incomplete rows", () => {
		expect(
			flattenBranchNames([{ name: "master" }, { name: "  " }, { sha: "abc" }]),
		).toEqual(["master"]);
	});
});
