import { beforeEach, describe, expect, it } from "vitest";
import {
	clearSnapshotCache,
	rememberSnapshot,
	SNAPSHOT_CACHE_CHARS,
	snapshotCacheState,
} from "./memory-repos";

describe("memory snapshot cache", () => {
	beforeEach(clearSnapshotCache);

	it("keeps retained text under its budget however many commits are read", () => {
		const file = "x".repeat(256 * 1024);
		let peak = 0;
		for (let commit = 0; commit < 200; commit++) {
			rememberSnapshot(`m:${commit}`, { "a.md": file, "b.md": file });
			peak = Math.max(peak, snapshotCacheState().chars);
		}
		expect(peak).toBeLessThanOrEqual(SNAPSHOT_CACHE_CHARS);
		expect(snapshotCacheState().entries).toBeLessThanOrEqual(16);
	});

	it("still caps the number of entries", () => {
		for (let commit = 0; commit < 200; commit++)
			rememberSnapshot(`m:${commit}`, { "a.md": "x" });
		expect(snapshotCacheState().entries).toBeLessThanOrEqual(64);
	});

	it("does not keep one snapshot larger than the whole budget", () => {
		rememberSnapshot("m:big", { "a.md": "x".repeat(SNAPSHOT_CACHE_CHARS + 1) });
		expect(snapshotCacheState()).toEqual({ entries: 0, chars: 0 });
	});
});
