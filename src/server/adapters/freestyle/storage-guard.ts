import { storageLevel } from "#/domain/storage-retention";
import { database } from "../database";

/** What the user sees while storage is nearly full; matches the provider-quota failure kind (calm, retried). */
export const STORAGE_FULL_MESSAGE =
	"Workspace storage is nearly full; your chat is queued and starts when space frees up.";

/** Observations older than this are ignored: a stale reading must never hold users back. */
const FRESH_MS = 30 * 60_000;

/**
 * Refuses a new machine above 95% of the storage quota, from the last fleet
 * observation (no provider call). Bookkeeping never blocks: a missing, stale
 * or unreadable observation lets the create through.
 */
export async function assertStorageHasRoom(
	read: () => Promise<{
		at: Date;
		fraction: number;
	} | null> = latestStorageObservation,
	now = new Date(),
) {
	let observation: { at: Date; fraction: number } | null = null;
	try {
		observation = await read();
	} catch {
		console.warn(
			"Storage guard could not read the fleet observation; allowing.",
		);
		return;
	}
	if (!observation || now.getTime() - observation.at.getTime() > FRESH_MS)
		return;
	if (storageLevel(observation.fraction) === "full")
		throw new Error(STORAGE_FULL_MESSAGE);
}

async function latestStorageObservation() {
	const result = await database().query<{ at: Date; fraction: string | null }>(
		"select observed_at at, projection->>'storageFraction' fraction from infrastructure_fleet_observation where singleton",
	);
	const row = result.rows[0];
	if (!row || row.fraction === null) return null;
	return { at: row.at, fraction: Number(row.fraction) };
}
