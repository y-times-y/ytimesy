/**
 * Process-local memo for data that stays fixed for one turn (or forever, for
 * content-addressed keys). Durable step mode runs each model step in its own
 * alarm; the chat's Durable Object usually keeps the isolate warm, so later
 * steps reuse what the first step loaded. An evicted or restarted isolate
 * simply loads again, so nothing here is needed for correctness.
 *
 * Only settled values are kept: a pending promise would be bound to the
 * request that started it, and a step aborted mid-load must not leave the next
 * step waiting on it. Failed loads are never kept.
 */
const MAX_ENTRIES = 512;
const TTL_MS = 2 * 60 * 60_000;
const entries = new Map<string, { expiresAt: number; value: unknown }>();

export async function turnMemo<T>(
	key: string,
	load: () => Promise<T>,
	/** False leaves the value uncached, so the next step loads it again. */
	keep: (value: T) => boolean = () => true,
): Promise<T> {
	const hit = entries.get(key);
	if (hit && hit.expiresAt > Date.now()) return hit.value as T;
	entries.delete(key);
	const value = await load();
	if (keep(value)) {
		entries.set(key, { expiresAt: Date.now() + TTL_MS, value });
		while (entries.size > MAX_ENTRIES) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	}
	return value;
}

/** Replaces a memoized value (a later step must see the corrected one). */
export function setTurnMemo<T>(key: string, value: T) {
	entries.delete(key);
	entries.set(key, { expiresAt: Date.now() + TTL_MS, value });
	while (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
}

/** Drops a finished turn's entries (they may hold decrypted project secrets). */
export function forgetTurnMemo(turnId: string) {
	const prefix = `${turnId}:`;
	for (const key of entries.keys())
		if (key.startsWith(prefix)) entries.delete(key);
}

export function clearTurnMemo() {
	entries.clear();
}
