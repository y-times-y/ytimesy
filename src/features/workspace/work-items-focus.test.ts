import { describe, expect, it } from "vitest";
import { workItemsTarget } from "./work-items-focus";

const connected = [{ fullName: "y-times-y/ytimesy", repositoryId: 7 }];

describe("workItemsTarget", () => {
	it("opens any pull request of a connected repository in the app", () => {
		expect(
			workItemsTarget(
				{
					kind: "pull-request",
					owner: "Y-Times-Y",
					repo: "ytimesy",
					number: 14,
				},
				connected,
				5,
			),
		).toEqual({
			page: "pull-requests",
			focus: { kind: "pull-request", repositoryId: 7, number: 14, at: 5 },
		});
	});
	it("opens an issue on the Issues page", () => {
		expect(
			workItemsTarget(
				{ kind: "issue", owner: "y-times-y", repo: "ytimesy", number: 3 },
				connected,
				1,
			)?.page,
		).toBe("issues");
	});
	it("leaves a repository the project does not have connected to GitHub", () => {
		expect(
			workItemsTarget(
				{ kind: "pull-request", owner: "acme", repo: "web", number: 1 },
				connected,
				1,
			),
		).toBeNull();
	});
});
