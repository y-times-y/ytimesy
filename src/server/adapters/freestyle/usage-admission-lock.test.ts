import { beforeEach, expect, it, vi } from "vitest";
import { lockedVm } from "./usage-admission";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("../database", () => ({
	database: () => ({ connect: async () => mocks }),
}));
const leased = { rows: [{ holder: "h" }] };
const busy = { rows: [] };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.query.mockReset().mockResolvedValue(leased);
});

it("runs under a lease and releases it", async () => {
	const operation = vi.fn(async () => "admitted");
	expect(await lockedVm("workspace", operation)).toBe("admitted");
	expect(mocks.query.mock.calls[0][0]).toContain(
		"insert into infrastructure_vm_lease",
	);
	expect(mocks.query.mock.calls[0][0]).toContain("expires_at < now()");
	expect(operation).toHaveBeenCalledWith(mocks);
	expect(mocks.query.mock.calls.at(-1)?.[0]).toBe(
		"delete from infrastructure_vm_lease where slug=$1 and holder=$2",
	);
	expect(mocks.release).toHaveBeenCalledWith(false);
});

it("waits for a held lease, then proceeds once it is free or expired", async () => {
	mocks.query
		.mockResolvedValueOnce(busy)
		.mockResolvedValueOnce(busy)
		.mockResolvedValue(leased);
	expect(await lockedVm("workspace", async () => "done", { pollMs: 1 })).toBe(
		"done",
	);
	expect(
		mocks.query.mock.calls.filter(([sql]) =>
			String(sql).includes("insert into infrastructure_vm_lease"),
		),
	).toHaveLength(3);
});

it("gives up after the wait without running the operation", async () => {
	mocks.query.mockResolvedValue(busy);
	const operation = vi.fn();
	await expect(
		lockedVm("workspace", operation, { waitMs: 5, pollMs: 1 }),
	).rejects.toThrow("Another operation is updating");
	expect(operation).not.toHaveBeenCalled();
	expect(
		mocks.query.mock.calls.some(([sql]) => String(sql).startsWith("delete")),
	).toBe(false);
});

it("releases the lease when the operation fails", async () => {
	await expect(
		lockedVm("workspace", async () => {
			throw new Error("failed");
		}),
	).rejects.toThrow("failed");
	expect(mocks.query.mock.calls.at(-1)?.[0]).toContain(
		"delete from infrastructure_vm_lease",
	);
	expect(mocks.release).toHaveBeenCalledWith(false);
});

it("discards the connection when releasing the lease fails", async () => {
	mocks.query
		.mockResolvedValueOnce(leased)
		.mockRejectedValueOnce(new Error("connection lost"));
	expect(await lockedVm("workspace", async () => "done")).toBe("done");
	expect(mocks.release).toHaveBeenCalledWith(true);
});
