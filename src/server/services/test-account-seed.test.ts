import { describe, expect, it } from "vitest";
import {
	pickSeedRepository,
	seedRepositoryIds,
	seedTestAccount,
	yDefaultCounts,
} from "./test-account-seed";

describe("test account extras", () => {
	it("counts only live projects and returns numbers, nothing identifying", async () => {
		const sql: string[] = [];
		const result = await yDefaultCounts({
			query: async (text: string) => {
				sql.push(text);
				return { rows: [{ on: "7", off: "2" }] } as never;
			},
		});
		expect(result).toEqual({ yOn: 7, yOff: 2 });
		expect(sql[0]).toContain("archived_at is null");
		expect(sql[0]).not.toMatch(/user_id|full_name|\bid\b/);
	});

	it("refuses to seed anyone but the synthetic account", async () => {
		await expect(
			seedTestAccount({ query: async () => ({ rows: [] }) }, "real-user", {}),
		).rejects.toThrow("not the test account");
	});
});

describe("seed repository", () => {
	it("takes the id GitHub lists now, not a stored one", () => {
		expect(
			pickSeedRepository([
				{ id: 1, full_name: "y-times-y/other" },
				{ id: 1462101001, full_name: "y-times-y/ytimesy" },
			])?.id,
		).toBe(1462101001);
	});
	it("ignores an archived or missing repository", () => {
		expect(
			pickSeedRepository([
				{ id: 2, full_name: "y-times-y/ytimesy", archived: true },
			]),
		).toBeUndefined();
	});
});

it("reports repository and installation ids only", async () => {
	const result = await seedRepositoryIds({
		query: async () =>
			({
				rows: [
					{ repository_id: "5", installation_id: "9", archived: false, n: "1" },
				],
			}) as never,
	});
	expect(result.stored).toEqual([
		{ repositoryId: 5, installationId: 9, archived: false, projects: 1 },
	]);
	expect(Object.keys(result.stored[0] ?? {}).sort()).toEqual([
		"archived",
		"installationId",
		"projects",
		"repositoryId",
	]);
});
