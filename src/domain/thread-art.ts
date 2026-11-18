/**
 * A thread's picture: one of a fixed set of smooth mesh-gradient images
 * (public/thread-art), chosen from the chat id so a thread always has the
 * same one. The images are made once, ahead of time, with scripts/thread-art
 * (a mesh gradient per palette and variant: smooth colour only, no grain,
 * no dithering), so the app shows plain cached images instead of running a
 * WebGL canvas per row.
 */

/**
 * The palettes, in the order the images were made. `base` is the darkest
 * colour, shown while the image loads.
 */
export const THREAD_ART_PALETTES = [
	{ name: "dusk", base: "#1b1464" },
	{ name: "ember", base: "#2a0a12" },
	{ name: "lagoon", base: "#04121f" },
	{ name: "meadow", base: "#062016" },
	{ name: "orchid", base: "#1a0833" },
	{ name: "citrus", base: "#3a1c00" },
	{ name: "glacier", base: "#0a1030" },
	{ name: "rosewood", base: "#2b0a1f" },
	{ name: "peach", base: "#3b1230" },
	{ name: "midnight", base: "#05050f" },
	{ name: "sunrise", base: "#1f0a3d" },
] as const;

/** Variants per palette: the same colours, a different swirl and framing. */
export const THREAD_ART_VARIANTS = 4;

export type ThreadArt = {
	readonly palette: (typeof THREAD_ART_PALETTES)[number]["name"];
	readonly variant: number;
	readonly base: string;
	readonly src: string;
};

/** FNV-1a: stable across runs and platforms, unlike anything seeded. */
function hash(text: string) {
	let value = 2166136261;
	for (let index = 0; index < text.length; index++) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 16777619);
	}
	return value >>> 0;
}

/** The picture for a thread (its chat id). The same id always gives the same one. */
export function threadArt(chatId: string): ThreadArt {
	const value = hash(chatId);
	const palette = THREAD_ART_PALETTES[value % THREAD_ART_PALETTES.length];
	// Dividing first keeps the variant independent of the palette.
	const variant =
		Math.floor(value / THREAD_ART_PALETTES.length) % THREAD_ART_VARIANTS;
	return {
		palette: palette.name,
		variant,
		base: palette.base,
		src: `/thread-art/${palette.name}-${variant}.jpg`,
	};
}
