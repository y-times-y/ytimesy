/** Text that arrived up to `end` (characters) at `at` (ms). */
export type TextArrival = { readonly end: number; readonly at: number };

/** The backlog shows within about this long at the current pace. */
export const REVEAL_CATCH_UP_MS = 250;
/** No character shows later than this after it arrived. */
export const REVEAL_MAX_LAG_MS = 1_000;
/** The slowest pace, so a short tail never crawls. */
const MIN_CHARS_PER_MS = 0.05;
/** A word that ends within this many characters shows whole. */
const WORD_END_REACH = 16;

/**
 * How much of a streaming reply shows after `elapsed` ms: a steady pace
 * that speeds up as the backlog grows (it drains in about
 * REVEAL_CATCH_UP_MS) and never leaves a character more than
 * REVEAL_MAX_LAG_MS behind its arrival. It stops at word ends where it can.
 */
export function revealedLength(input: {
	readonly text: string;
	readonly shown: number;
	readonly arrivals: readonly TextArrival[];
	readonly now: number;
	readonly elapsed: number;
}): number {
	const { text, shown, arrivals, now, elapsed } = input;
	const backlog = text.length - shown;
	if (backlog <= 0) return text.length;
	let pace = Math.max(MIN_CHARS_PER_MS, backlog / REVEAL_CATCH_UP_MS);
	for (const arrival of arrivals) {
		if (arrival.end <= shown) continue;
		const left = arrival.at + REVEAL_MAX_LAG_MS - now;
		if (left <= elapsed)
			return Math.max(shown, wordEnd(text, Math.min(arrival.end, text.length)));
		pace = Math.max(pace, (arrival.end - shown) / left);
	}
	const next = Math.min(
		text.length,
		shown + Math.max(1, Math.round(pace * elapsed)),
	);
	return wordEnd(text, next);
}

/** `index`, moved to the end of the word it falls in when that end is near. */
function wordEnd(text: string, index: number): number {
	if (index >= text.length || /\s/.test(text[index - 1] ?? " ")) return index;
	for (
		let end = index;
		end < Math.min(text.length, index + WORD_END_REACH);
		end++
	)
		if (/\s/.test(text[end] ?? "")) return end;
	return index;
}
