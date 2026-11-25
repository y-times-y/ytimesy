import { describe, expect, it } from "vitest";
import { seedTestAccount, yDefaultCounts } from "./test-account-seed";

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
