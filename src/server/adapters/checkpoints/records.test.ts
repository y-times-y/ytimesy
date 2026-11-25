import { beforeEach, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../database", () => ({ database: () => ({ query }) }));

import {
	CHECKPOINT_RUN_LEASE_SECONDS,
	claimSessionCheckpointRun,
	releaseSessionCheckpointRun,
} from "./records";

beforeEach(() => query.mockReset());

it("claims the lease only when the insert returns the row", async () => {
	query.mockResolvedValueOnce({ rows: [{ lease_id: "l1" }] });
	expect(await claimSessionCheckpointRun("s1", 3, "l1")).toEqual({
		kind: "claimed",
		leaseId: "l1",
	});
	const [sql, values] = query.mock.calls[0];
	// One statement: the fleet cap and the held-lease check are in the insert itself.
	expect(sql).toMatch(/where \(select count\(\*\) from session_checkpoint_run/);
	expect(sql).toMatch(/where session_checkpoint_run\.expires_at<=now\(\)/);
	expect(values).toEqual(["s1", "l1", 3, CHECKPOINT_RUN_LEASE_SECONDS]);
	query.mockResolvedValueOnce({ rows: [] });
	expect(await claimSessionCheckpointRun("s1", 3, "l2")).toEqual({
		kind: "busy",
	});
});

it("reports an absent lease table so the caller can fall back", async () => {
	query.mockRejectedValueOnce(
		Object.assign(new Error("no table"), { code: "42P01" }),
	);
	expect(await claimSessionCheckpointRun("s1", 3, "l1")).toEqual({
		kind: "unavailable",
	});
	query.mockRejectedValueOnce(new Error("connection reset"));
	await expect(claimSessionCheckpointRun("s1", 3, "l1")).rejects.toThrow(
		"connection reset",
	);
});

it("releases only the lease the run holds", async () => {
	query.mockResolvedValueOnce({ rows: [] });
	await releaseSessionCheckpointRun("s1", "l1");
	expect(query.mock.calls[0][0]).toMatch(/lease_id=\$2/);
});
