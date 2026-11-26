import type { Freestyle, VmData } from "freestyle";
import { fleetCostProjection } from "#/domain/infrastructure-costs";
import { storageUsage } from "#/domain/storage-retention";
import { database } from "../database";
import { storageQuotaGiB } from "./storage-retention";

/** Includes legacy disks and the worker; cannot infer snapshot/transfer charges or discounts. */
export async function observeFleetCosts(client: Freestyle) {
	const vms: VmData[] = [];
	for (let offset = 0; offset < 10_000; offset += 100) {
		const page = await client.vms.list({ limit: 100, offset });
		vms.push(...page.vms);
		if (offset + page.vms.length >= page.totalCount) break;
		if (!page.vms.length || offset === 9900)
			throw new Error("Fleet inventory could not be completed.");
	}
	const snapshots = await client.vms.snapshots.list({ limit: 1 });
	const projection = {
		...fleetCostProjection(vms, snapshots.totalCount),
		// Read by the creation guard (storage-guard.ts).
		storageFraction: storageUsage(vms, snapshots.totalCount, storageQuotaGiB())
			.fraction,
	};
	await database().query(
		"insert into infrastructure_fleet_observation(singleton,observed_at,projection) values(true,now(),$1) on conflict(singleton) do update set observed_at=excluded.observed_at,projection=excluded.projection",
		[JSON.stringify(projection)],
	);
	return projection;
}
