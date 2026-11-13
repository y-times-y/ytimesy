import { describe, expect, it } from "vitest";
import {
	deploySourceProblem,
	productionBuildSourceProblem,
} from "../scripts/production-source";

const main = "ee011af376d8aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const old = "969b5dd1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("deploySourceProblem", () => {
	it("allows exactly origin/main with no tracked changes", () => {
		expect(
			deploySourceProblem({ head: main, originMain: main, trackedChanges: "" }),
		).toBeNull();
	});

	it("refuses a checkout on an older commit", () => {
		const problem = deploySourceProblem({
			head: old,
			originMain: main,
			trackedChanges: "",
		});
		expect(problem).toContain("969b5dd1");
		expect(problem).toContain("ee011af3");
	});

	it("refuses changed tracked files and names them", () => {
		const problem = deploySourceProblem({
			head: main,
			originMain: main,
			trackedChanges: " M src/router.tsx\n M package.json\n",
		});
		expect(problem).toContain("src/router.tsx");
	});

	it("refuses when a commit could not be read", () => {
		expect(
			deploySourceProblem({ head: "", originMain: main, trackedChanges: "" }),
		).not.toBeNull();
	});
});

describe("productionBuildSourceProblem", () => {
	it("allows a checkout that contains origin/main", () => {
		expect(
			productionBuildSourceProblem({
				head: old,
				originMain: main,
				containsOriginMain: true,
			}),
		).toBeNull();
	});

	it("refuses a checkout missing origin/main and names both commits", () => {
		const problem = productionBuildSourceProblem({
			head: old,
			originMain: main,
			containsOriginMain: false,
		});
		expect(problem).toContain("969b5dd1");
		expect(problem).toContain("ee011af3");
	});

	it("refuses when origin/main could not be fetched", () => {
		expect(
			productionBuildSourceProblem({
				head: main,
				originMain: "",
				containsOriginMain: false,
			}),
		).not.toBeNull();
	});
});
