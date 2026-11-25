import { describe, expect, it, vi } from "vitest";
import {
	TEST_ACCOUNT_REPOSITORY,
	testAccountGithubToken,
} from "./test-account-github";

describe("the test account's GitHub access", () => {
	it("gives every other user nothing, without touching GitHub or the database", async () => {
		const mint = vi.fn();
		const lookup = vi.fn();
		expect(
			await testAccountGithubToken("real-user", { lookup, mint }),
		).toBeNull();
		expect(mint).not.toHaveBeenCalled();
		expect(lookup).not.toHaveBeenCalled();
	});

	it("mints a read-only token for the one seed repository only", async () => {
		const mint = vi.fn(async () => "ghs_secret");
		const token = await testAccountGithubToken("ytimesy-test-account", {
			lookup: async () => 42,
			mint,
		});
		expect(token).toBe("ghs_secret");
		expect(mint).toHaveBeenCalledWith(42, {
			repositoryNames: [TEST_ACCOUNT_REPOSITORY.name],
			contents: "read",
		});
	});

	it("refuses when the seed repository has no installation", async () => {
		await expect(
			testAccountGithubToken("ytimesy-test-account", {
				lookup: async () => null,
				mint: vi.fn(),
			}),
		).rejects.toThrow("seed repository");
	});
});
