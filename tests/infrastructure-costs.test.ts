import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { fleetCostProjection } from "../src/domain/infrastructure-costs";

it("includes paused disks and active worker compute without claiming unknown invoice charges", () => {
	const resources = { cpu: 2, memory: 4096, storage: 16384 };
	expect(
		fleetCostProjection(
			[
				{ state: "running", resources },
				{ state: "paused", resources },
			],
			13,
		),
	).toEqual({
		vmCount: 2,
		activeVms: 1,
		snapshotCount: 13,
		computeHourlyMicroUsd: 132240,
		storageMonthlyMicroUsd: 1981440,
		snapshotChargesKnown: false,
		transferChargesKnown: false,
		invoiceVerified: false,
	});
});
it("rejects unknown resource dimensions instead of underestimating costs", () => {
	expect(() =>
		fleetCostProjection(
			[
				{
					state: "running",
					resources: { cpu: 2, memory: NaN, storage: 16384 },
				},
			],
			1,
		),
	).toThrow();
});
it("keeps cost observations inaccessible to browser database roles", async () => {
	const db = new PGlite();
	try {
		await db.exec("create role anon; create role authenticated");
		await db.exec(
			readFileSync(
				"supabase/migrations/20261003023000_infrastructure_cost_observations.sql",
				"utf8",
			),
		);
		expect(
			(
				await db.query(
					"select relrowsecurity from pg_class where relname='infrastructure_fleet_observation'",
				)
			).rows[0],
		).toMatchObject({ relrowsecurity: true });
		await db.exec("set role authenticated");
		await expect(
			db.query("select * from infrastructure_fleet_observation"),
		).rejects.toThrow("permission");
	} finally {
		await db.close();
	}
}, 15_000);
