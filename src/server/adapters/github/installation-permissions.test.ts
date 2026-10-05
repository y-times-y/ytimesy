import { expect, it, vi } from "vitest";
import { createOctokitGitHubListing } from "./octokit-app";

const auth = vi.hoisted(() => vi.fn());
vi.mock("octokit", () => ({
	App: class {
		async getInstallationOctokit() {
			return { auth };
		}
	},
}));

it("requests PR write permission through the SDK while preserving content-only broker scopes", async () => {
	auth.mockResolvedValue({ token: "installation-token-fixture" });
	const listing = createOctokitGitHubListing();
	const input = {
		credentials: { appId: "123", privateKey: "fixture-key", slug: null },
		installationId: "456",
		repositoryNames: ["repo"],
		contents: "read" as const,
	};
	await listing.installationToken({ ...input, pullRequests: "write" });
	expect(auth).toHaveBeenLastCalledWith({
		type: "installation",
		repositoryNames: ["repo"],
		permissions: { contents: "read", pull_requests: "write" },
	});
	await listing.installationToken({ ...input, contents: "write" });
	expect(auth).toHaveBeenLastCalledWith({
		type: "installation",
		repositoryNames: ["repo"],
		permissions: { contents: "write" },
	});
});
