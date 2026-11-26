import { describe, expect, it, vi } from "vitest";
import { sweepStorage } from "./storage-retention";

const DAY = 86_400_000;
const now = new Date("2026-11-26T12:00:00Z");
const vm = (id: string, state: string, idleDays: number) => ({
	id,
	state,
	resources: { storage: 32768 },
	lastNetworkActivity: new Date(now.getTime() - idleDays * DAY).toISOString(),
});

function deps(over: Partial<Parameters<typeof sweepStorage>[0]> = {}) {
	return {
		now,
		quotaGiB: 3125,
		listVms: vi.fn(async () => [
			vm("vm-a", "paused", 8),
			vm("vm-b", "paused", 1),
		]),
		snapshotCount: vi.fn(async () => 0),
		idleChatMachines: vi.fn(async () => ["vm-a", "vm-b"]),
		staleBuildMachines: vi.fn(async () => [] as string[]),
		destroyVm: vi.fn(async () => undefined),
		markBuildReleased: vi.fn(async () => undefined),
		alert: vi.fn(async () => undefined),
		...over,
	};
}

describe("sweepStorage", () => {
	it("deletes only machines the database allows AND the provider shows idle for 7 days", async () => {
		const d = deps();
		const result = await sweepStorage(d);
		expect(d.destroyVm).toHaveBeenCalledTimes(1);
		expect(d.destroyVm).toHaveBeenCalledWith("vm-a");
		expect(result.deletedIdle).toBe(1);
	});

	it("never deletes a running machine or one the database did not name", async () => {
		const d = deps({
			listVms: vi.fn(async () => [
				vm("vm-a", "running", 30),
				vm("vm-z", "paused", 30),
			]),
		});
		await sweepStorage(d);
		expect(d.destroyVm).not.toHaveBeenCalled();
	});

	it("deletes stale build machines and records the release", async () => {
		const d = deps({
			idleChatMachines: vi.fn(async () => []),
			staleBuildMachines: vi.fn(async () => ["vm-b"]),
		});
		const result = await sweepStorage(d);
		expect(d.destroyVm).toHaveBeenCalledWith("vm-b");
		expect(d.markBuildReleased).toHaveBeenCalledWith("vm-b");
		expect(result.deletedBuilds).toBe(1);
	});

	it("one failed delete does not stop the rest", async () => {
		const destroyVm = vi.fn(async (id: string) => {
			if (id === "vm-a") throw new Error("provider down");
		});
		const d = deps({
			listVms: vi.fn(async () => [
				vm("vm-a", "paused", 9),
				vm("vm-c", "paused", 9),
			]),
			idleChatMachines: vi.fn(async () => ["vm-a", "vm-c"]),
			destroyVm,
		});
		const result = await sweepStorage(d);
		expect(destroyVm).toHaveBeenCalledTimes(2);
		expect(result.deletedIdle).toBe(1);
	});

	it("alerts at 90% after the sweep, from the usage that remains", async () => {
		const many = Array.from({ length: 90 }, (_, i) =>
			vm(`vm-${i}`, "paused", 1),
		);
		const d = deps({
			listVms: vi.fn(async () => many),
			idleChatMachines: vi.fn(async () => []),
			quotaGiB: 3125,
		});
		const result = await sweepStorage(d);
		// 90 x 32 GiB = 2880 of 3125 = 92%
		expect(result.level).toBe("warn-90");
		expect(d.alert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "storage-quota" }),
		);
	});

	it("never fails the job when the alert or a query fails", async () => {
		const d = deps({
			idleChatMachines: vi.fn(async () => {
				throw new Error("db down");
			}),
			alert: vi.fn(async () => {
				throw new Error("mail down");
			}),
		});
		await expect(sweepStorage(d)).resolves.toBeDefined();
	});
});
