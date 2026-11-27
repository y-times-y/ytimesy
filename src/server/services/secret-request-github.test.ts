import { describe, expect, it } from "vitest";
import { isGithubCredentialName } from "#/domain/github-credential-request";
import { secretRequestTools } from "./secret-request-tool";

const ask = (secrets: { name: string }[]) =>
	(
		secretRequestTools([]).request_project_secret?.execute as (
			i: unknown,
			o: unknown,
		) => Promise<Record<string, unknown>>
	)(
		{
			secrets: secrets.map((s) => ({ ...s, kind: "runtime", reason: "r" })),
		},
		{},
	);

describe("request_project_secret for GitHub", () => {
	it("names that are GitHub credentials", () => {
		for (const name of [
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"github_pat",
			"GITHUB_API_TOKEN",
		])
			expect(isGithubCredentialName(name)).toBe(true);
		for (const name of ["STRIPE_API_KEY", "GITHUB_REPO", "TOKEN"])
			expect(isGithubCredentialName(name)).toBe(false);
	});

	it("redirects a request that is only for a GitHub token, without a card", async () => {
		expect(await ask([{ name: "GH_TOKEN" }])).toEqual({
			requested: false,
			error:
				"GitHub is connected; push the branch; the platform opens the pull request at the end of the turn.",
		});
	});

	it("drops the GitHub name from a mixed request and keeps the rest", async () => {
		const out = await ask([
			{ name: "GITHUB_TOKEN" },
			{ name: "STRIPE_API_KEY" },
		]);
		expect(out).toMatchObject({
			requested: true,
			secrets: [{ name: "STRIPE_API_KEY" }],
			note: expect.stringContaining("GitHub is connected"),
		});
	});
});
