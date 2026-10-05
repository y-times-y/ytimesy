import { beforeEach, expect, it, vi } from "vitest";
import { lockedVm } from "./usage-admission";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("../database", () => ({
	database: () => ({ connect: async () => mocks }),
}));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.query
		.mockReset()
		.mockResolvedValue({ rows: [{ statement_timeout: "2min" }] });
});

it("waits through PostgreSQL rather than rejecting normal admission contention", async () => {
	const operation = vi.fn(async () => "admitted");
	expect(await lockedVm("workspace", operation)).toBe("admitted");
	expect(mocks.query).toHaveBeenNthCalledWith(
		3,
		"select pg_advisory_lock(hashtextextended($1,81738421))",
		["workspace"],
	);
	expect(mocks.query).toHaveBeenNthCalledWith(
		2,
		"select set_config('statement_timeout','20s',false)",
	);
	expect(mocks.query).toHaveBeenNthCalledWith(
		4,
		"select set_config('statement_timeout',$1,false)",
		["2min"],
	);
	expect(operation).toHaveBeenCalledWith(mocks);
	expect(mocks.release).toHaveBeenCalledWith(false);
});

it("unlocks on operation failure before returning the session to the pool", async () => {
	await expect(
		lockedVm("workspace", async () => {
			throw new Error("failed");
		}),
	).rejects.toThrow("failed");
	expect(mocks.query).toHaveBeenLastCalledWith(
		"select pg_advisory_unlock(hashtextextended($1,81738421))",
		["workspace"],
	);
	expect(mocks.release).toHaveBeenCalledWith(false);
});

it("discards uncertain sessions after an acquisition timeout without running the operation", async () => {
	mocks.query
		.mockResolvedValueOnce({ rows: [{ statement_timeout: "2min" }] })
		.mockResolvedValueOnce({ rows: [] })
		.mockRejectedValueOnce(new Error("statement timeout"));
	const operation = vi.fn();
	await expect(lockedVm("workspace", operation)).rejects.toThrow(
		"statement timeout",
	);
	expect(operation).not.toHaveBeenCalled();
	expect(mocks.release).toHaveBeenCalledWith(true);
});

it("unlocks and discards a session if restoring its timeout fails", async () => {
	mocks.query
		.mockResolvedValueOnce({ rows: [{ statement_timeout: "2min" }] })
		.mockResolvedValueOnce({ rows: [] })
		.mockResolvedValueOnce({ rows: [] })
		.mockRejectedValueOnce(new Error("restore failed"));
	const operation = vi.fn();
	await expect(lockedVm("workspace", operation)).rejects.toThrow(
		"restore failed",
	);
	expect(operation).not.toHaveBeenCalled();
	expect(mocks.query).toHaveBeenLastCalledWith(
		"select pg_advisory_unlock(hashtextextended($1,81738421))",
		["workspace"],
	);
	expect(mocks.release).toHaveBeenCalledWith(true);
});

it("discards a session when unlock fails", async () => {
	mocks.query
		.mockResolvedValueOnce({ rows: [{ statement_timeout: "2min" }] })
		.mockResolvedValueOnce({ rows: [] })
		.mockResolvedValueOnce({ rows: [] })
		.mockResolvedValueOnce({ rows: [] })
		.mockRejectedValueOnce(new Error("connection lost"));
	expect(await lockedVm("workspace", async () => "done")).toBe("done");
	expect(mocks.release).toHaveBeenCalledWith(true);
});
