import type { OwnerAlert } from "#/domain/owner-alerts";

/** Freestyle Hobby plan storage, in GiB (override with YTIMESY_STORAGE_QUOTA_GIB). */
export const FREESTYLE_STORAGE_QUOTA_GIB = 3125;
/** A snapshot bills like a disk; its size is not in the list API, so assume the largest machine. */
export const SNAPSHOT_ASSUMED_GIB = 32;
/** A chat machine nobody used for this long goes (its checkpoint is the recovery). */
export const IDLE_WORKSPACE_DAYS = 7;
/** An unreferenced snapshot older than this goes. */
export const ORPHAN_SNAPSHOT_DAYS = 7;

export type StorageLevel = "ok" | "warn-80" | "warn-90" | "full";

export function storageUsage(
	vms: readonly { resources: { storage: number } }[],
	snapshotCount: number,
	quotaGiB = FREESTYLE_STORAGE_QUOTA_GIB,
) {
	const usedGiB =
		vms.reduce((sum, vm) => sum + vm.resources.storage / 1024, 0) +
		snapshotCount * SNAPSHOT_ASSUMED_GIB;
	return { usedGiB, quotaGiB, fraction: usedGiB / quotaGiB };
}

export function storageLevel(fraction: number): StorageLevel {
	if (fraction >= 0.95) return "full";
	if (fraction >= 0.9) return "warn-90";
	if (fraction >= 0.8) return "warn-80";
	return "ok";
}

/** One owner email per level and UTC day. */
export function storageAlert(
	level: StorageLevel,
	usedGiB: number,
	quotaGiB: number,
	now = new Date(),
): OwnerAlert | null {
	if (level === "ok") return null;
	const percent = { "warn-80": 80, "warn-90": 90, full: 95 }[level];
	return {
		kind: "storage-quota",
		key: `${level}:${now.toISOString().slice(0, 10)}`,
		subject: `ytimesy: Freestyle storage at ${percent}%`,
		text: `Freestyle storage is above ${percent}%: about ${Math.round(usedGiB)} of ${quotaGiB} GiB allocated (machines plus snapshots).${level === "full" ? " New machines are held back (chats show a calm queued status) until retention frees space." : ""} The scheduled retention job deletes archived and idle chat machines, stale builds and orphaned snapshots; check it if this repeats.`,
	};
}
