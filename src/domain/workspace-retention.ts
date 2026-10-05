export const WORKSPACE_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const WORKSPACE_RECYCLE_IDLE_SECONDS = 60 * 60;

/** A provider's shorter expiry is not permission to silently shorten our recovery promise. */
export function snapshotSupportsRetention(input: {
	public: boolean;
	sourceVmId?: string | null;
	expectedSourceVmId: string;
	createdAt: string;
	lastUsedAt?: string | null;
	autoDeleteSeconds?: number | null;
	ttlSeconds?: number | null;
	expiresAt: number;
}) {
	if (input.public || input.sourceVmId !== input.expectedSourceVmId)
		return false;
	const created = Date.parse(input.createdAt);
	const lastUsed = Date.parse(input.lastUsedAt ?? input.createdAt);
	if (!Number.isFinite(created) || !Number.isFinite(lastUsed)) return false;
	const idleExpiry =
		input.autoDeleteSeconds == null || input.autoDeleteSeconds < 0
			? Infinity
			: lastUsed + input.autoDeleteSeconds * 1000;
	const absoluteExpiry =
		input.ttlSeconds == null || input.ttlSeconds < 0
			? Infinity
			: created + input.ttlSeconds * 1000;
	return Math.min(idleExpiry, absoluteExpiry) >= input.expiresAt;
}
