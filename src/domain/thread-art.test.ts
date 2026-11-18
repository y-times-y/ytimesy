import { describe, expect, it } from "vitest";
import {
	THREAD_ART_PALETTES,
	THREAD_ART_VARIANTS,
	threadArt,
} from "./thread-art";

describe("threadArt", () => {
	it("gives a thread the same picture every time", () => {
		const id = "3f9a2b1c-7d4e-4f10-9a55-0c2d8e6b1a77";
		expect(threadArt(id)).toEqual(threadArt(id));
	});

	it("points at an image that exists for every palette and variant", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 4000; index++) {
			const art = threadArt(`chat-${index}`);
			expect(art.src).toMatch(/^\/thread-art\/[a-z]+-[0-3]\.jpg$/);
			expect(art.variant).toBeGreaterThanOrEqual(0);
			expect(art.variant).toBeLessThan(THREAD_ART_VARIANTS);
			seen.add(art.src);
		}
		// Nothing is unreachable: every one of the images is used.
		expect(seen.size).toBe(THREAD_ART_PALETTES.length * THREAD_ART_VARIANTS);
	});

	it("spreads threads across the palettes", () => {
		const counts = new Map<string, number>();
		for (let index = 0; index < 1100; index++) {
			const { palette } = threadArt(`id-${index}`);
			counts.set(palette, (counts.get(palette) ?? 0) + 1);
		}
		expect(counts.size).toBe(THREAD_ART_PALETTES.length);
		for (const count of counts.values()) expect(count).toBeGreaterThan(50);
	});
});
