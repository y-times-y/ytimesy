import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	normalizeGitHubPrivateKey,
	readGitHubAppCredentials,
} from "./credentials";

describe("normalizeGitHubPrivateKey", () => {
	it("turns escaped PEM newlines into a real key block", () => {
		expect(
			normalizeGitHubPrivateKey(
				"-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
			),
		).toBe(
			"-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
		);
	});
});

describe("readGitHubAppCredentials", () => {
	it("fails when the App id or private key is missing", async () => {
		const missing = await Effect.runPromiseExit(readGitHubAppCredentials({}));
		expect(Exit.isFailure(missing)).toBe(true);
		expect(String(missing)).toContain("MissingGitHubAppCredentials");
	});

	it("reads a present App id, PEM, and slug", async () => {
		await expect(
			Effect.runPromise(
				readGitHubAppCredentials({
					GITHUB_APP_ID: " 4932652 ",
					GITHUB_PRIVATE_KEY:
						"-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
					GITHUB_APP_SLUG: " ytimesy ",
				}),
			),
		).resolves.toEqual({
			appId: "4932652",
			privateKey:
				"-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
			slug: "ytimesy",
		});
	});
});
