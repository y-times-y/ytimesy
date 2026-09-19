/**
 * A project snapshot is the clean clone-source tree plus install, not a
 * chat's working branch. Refresh when that source commit moves. Keep the
 * last good snapshot active until a newer seal succeeds.
 */
export function projectSnapshotNeedsRefresh(input: {
	readonly sealedSha?: string | null;
	readonly remoteSha?: string | null;
}): boolean {
	const remote = input.remoteSha?.trim().toLowerCase();
	if (!remote) return false;
	const sealed = input.sealedSha?.trim().toLowerCase();
	if (!sealed) return true;
	return sealed !== remote;
}

export function projectSnapshotSourceRef(input: {
	readonly cloneBranch: string;
	readonly defaultBranch?: string;
}): string {
	return input.cloneBranch.trim() || input.defaultBranch?.trim() || "";
}
