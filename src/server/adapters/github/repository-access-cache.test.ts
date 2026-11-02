import { describe, expect, it, vi } from "vitest";
import {
	REPOSITORY_ACCESS_TTL_MS,
	repositoryAccessCache,
} from "./repository-access-cache";

const key = { userId: "user-1", installationId: 11, repositoryId: 3 };
const choice = {
	installationId: 11,
	repositoryId: 3,
	fullName: "acme/app",
	defaultBranch: "main",
	private: true,
};

describe("repository access cache", () => {
	it("checks once, reuses the answer within the TTL and checks again after it", async () => {
		let clock = 0;
		const cache = repositoryAccessCache({ now: () => clock });
		const check = vi.fn(async () => choice);
		await expect(cache.access(key, check)).resolves.toEqual(choice);
		clock = REPOSITORY_ACCESS_TTL_MS - 1;
		await cache.access(key, check);
		expect(check).toHaveBeenCalledTimes(1);
		clock = REPOSITORY_ACCESS_TTL_MS;
		await cache.access(key, check);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it("keys by user, installation and repository", async () => {
		const cache = repositoryAccessCache({ now: () => 0 });
		const check = vi.fn(async () => choice);
		await cache.access(key, check);
		await cache.access({ ...key, userId: "user-2" }, check);
		await cache.access({ ...key, installationId: 12 }, check);
		await cache.access({ ...key, repositoryId: 4 }, check);
		expect(check).toHaveBeenCalledTimes(4);
	});

	it("shares one check between concurrent reads", async () => {
		const cache = repositoryAccessCache({ now: () => 0 });
		const check = vi.fn(async () => choice);
		await Promise.all([cache.access(key, check), cache.access(key, check)]);
		expect(check).toHaveBeenCalledTimes(1);
	});

	it("never keeps a denial, so a new grant works at once", async () => {
		const cache = repositoryAccessCache({ now: () => 0 });
		const denied = new Response("no", { status: 403 });
		await expect(cache.access(key, () => Promise.reject(denied))).rejects.toBe(
			denied,
		);
		const check = vi.fn(async () => choice);
		await expect(cache.access(key, check)).resolves.toEqual(choice);
		expect(check).toHaveBeenCalledTimes(1);
	});

	it("forgets the access when GitHub refuses the token, not on other failures", async () => {
		const cache = repositoryAccessCache({ now: () => 0 });
		const check = vi.fn(async () => choice);
		await cache.access(key, check);
		expect(() => cache.refused(key)(new Error("timeout"))).toThrow("timeout");
		await cache.access(key, check);
		expect(check).toHaveBeenCalledTimes(1);
		const refusal = Object.assign(new Error("Not Found"), { status: 404 });
		expect(() => cache.refused(key)(refusal)).toThrow(refusal);
		await cache.access(key, check);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it("holds at most maxEntries, dropping the oldest", async () => {
		const cache = repositoryAccessCache({ now: () => 0, maxEntries: 2 });
		const check = vi.fn(async () => choice);
		for (const repositoryId of [1, 2, 3])
			await cache.access({ ...key, repositoryId }, check);
		await cache.access({ ...key, repositoryId: 3 }, check);
		expect(check).toHaveBeenCalledTimes(3);
		await cache.access({ ...key, repositoryId: 1 }, check);
		expect(check).toHaveBeenCalledTimes(4);
	});
});
