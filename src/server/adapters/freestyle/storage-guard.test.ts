import { describe, expect, it } from "vitest";
import { machineFailureKind } from "./machine-failure";
import { assertStorageHasRoom, STORAGE_FULL_MESSAGE } from "./storage-guard";

const now = new Date("2026-11-26T12:00:00Z");
const at = (minutesAgo: number) =>
	new Date(now.getTime() - minutesAgo * 60_000);

describe("assertStorageHasRoom", () => {
	it("refuses above 95% with the calm message, classified as a quota wait", async () => {
		const error = await assertStorageHasRoom(
			async () => ({ at: at(1), fraction: 0.96 }),
			now,
		).catch((e) => e);
		expect(error.message).toBe(STORAGE_FULL_MESSAGE);
		expect(machineFailureKind(error)).toBe("quota");
	});
	it("allows at 94%", async () => {
		await expect(
			assertStorageHasRoom(async () => ({ at: at(1), fraction: 0.94 }), now),
		).resolves.toBeUndefined();
	});
	it("allows when the reading is stale, missing or unreadable", async () => {
		await expect(
			assertStorageHasRoom(async () => ({ at: at(120), fraction: 0.99 }), now),
		).resolves.toBeUndefined();
		await expect(
			assertStorageHasRoom(async () => null, now),
		).resolves.toBeUndefined();
		await expect(
			assertStorageHasRoom(async () => {
				throw new Error("db");
			}, now),
		).resolves.toBeUndefined();
	});
});
