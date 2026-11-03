import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import {
	forgetInstallationTokens,
	githubInstallationAccessToken,
	INSTALLATION_TOKEN_REUSE_MS,
} from "./installation-token";

const mint = vi.hoisted(() => vi.fn());
vi.mock("./credentials", () => ({
	readGitHubAppCredentials: () => Effect.succeed({ appId: "1" }),
}));
vi.mock("./octokit-app", () => ({
	createOctokitGitHubListing: () => ({ installationToken: mint }),
}));

beforeEach(() => {
	vi.useRealTimers();
	forgetInstallationTokens();
	mint.mockReset();
	let count = 0;
	mint.mockImplementation(async () => `token-${++count}`);
});

it("reuses a minted token for the same installation and scope", async () => {
	const scope = { repositoryNames: ["repo"], contents: "write" as const };
	const [first, second] = await Promise.all([
		githubInstallationAccessToken(7, scope),
		githubInstallationAccessToken("7", scope),
	]);
	expect(first).toBe("token-1");
	expect(second).toBe("token-1");
	expect(mint).toHaveBeenCalledOnce();
	// Another scope or installation mints its own.
	expect(
		await githubInstallationAccessToken(7, {
			repositoryNames: ["repo"],
			contents: "read",
		}),
	).toBe("token-2");
	expect(await githubInstallationAccessToken(8, scope)).toBe("token-3");
});

it("mints again after the reuse window and after a failed mint", async () => {
	vi.useFakeTimers();
	const scope = { repositoryNames: ["repo"] };
	expect(await githubInstallationAccessToken(7, scope)).toBe("token-1");
	vi.advanceTimersByTime(INSTALLATION_TOKEN_REUSE_MS + 1);
	expect(await githubInstallationAccessToken(7, scope)).toBe("token-2");
	mint.mockRejectedValueOnce(new Error("GitHub is down"));
	forgetInstallationTokens(7);
	await expect(githubInstallationAccessToken(7, scope)).rejects.toThrow(
		"GitHub is down",
	);
	expect(await githubInstallationAccessToken(7, scope)).toBe("token-3");
});
