/** A row of a transcript list, as far as its height goes. */
export type SizedRow = {
	readonly key: string;
	readonly kind: string;
	/** Its height (px, with margins) as the transcript guesses it from its content. */
	readonly estimate: number;
};

/** A row's measured height: its border box and its vertical margins (px), at a list width. */
export type RowHeight = {
	readonly box: number;
	readonly margins: number;
};

/**
 * How many rows' heights are kept. A chat pages in at most a few hundred
 * rows at a time; this holds a long chat read back to its start, and a
 * few others, without growing for the life of the tab.
 */
const REMEMBERED_ROWS = 5_000;

/**
 * Weight (px) of the assumption that a kind's estimates are right, before
 * its rows are measured: a single odd row does not swing every estimate.
 */
const PRIOR_PX = 400;

/** The furthest a kind's learned correction scales its estimates. */
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

/**
 * What a transcript list has learned about its rows' heights in this tab:
 * each rendered row's height by key, and how far each kind's estimates ran
 * from the heights measured. A row not mounted takes its own height if it
 * was measured at this width (on an earlier page of older turns, or before
 * the list remounted), or else its estimate corrected by what its kind's
 * rows measured. Rows mounted above the view then need few corrections, and
 * the scrollbar keeps its size while older turns load.
 *
 * Heights hold at the width they were measured at: once rows measure at
 * another width (the window or a panel resized), the earlier ones count as
 * unmeasured until they mount again.
 *
 * Only rendered rows teach it: a row the browser skips (content-visibility)
 * measures as the room it was given, which says nothing about its content.
 */
export class RowHeights {
	readonly #rows = new Map<string, RowHeight & { readonly width: number }>();
	readonly #kinds = new Map<
		string,
		{ estimated: number; measured: number; margins: number; rows: number }
	>();
	readonly #limit: number;
	/** The list's width (px) when a row was last measured. */
	#width: number | null = null;

	constructor(limit = REMEMBERED_ROWS) {
		this.#limit = limit;
	}

	/** Records a rendered row's height at the list's width (px). */
	measured(row: SizedRow, height: RowHeight, width: number) {
		this.#width = width;
		const known = this.#rows.has(row.key);
		// Most recently measured last: the oldest rows are forgotten first.
		this.#rows.delete(row.key);
		this.#rows.set(row.key, { ...height, width });
		if (this.#rows.size > this.#limit) {
			const oldest = this.#rows.keys().next().value;
			if (oldest !== undefined) this.#rows.delete(oldest);
		}
		// Each row teaches its kind once: a row measured again as it streams
		// or remounts would otherwise outweigh the others.
		if (known) return;
		const kind = this.#kinds.get(row.kind) ?? {
			estimated: 0,
			measured: 0,
			margins: 0,
			rows: 0,
		};
		kind.estimated += row.estimate;
		kind.measured += height.box + height.margins;
		kind.margins += height.margins;
		kind.rows += 1;
		this.#kinds.set(row.kind, kind);
	}

	/** The height (px, with margins) to give a row until it is measured. */
	estimate(row: SizedRow): number {
		const known = this.#known(row);
		if (known) return known.box + known.margins;
		return Math.round(row.estimate * this.#ratio(row.kind));
	}

	/**
	 * The room (px, without margins) a mounted row takes while the browser
	 * skips laying it out: its own last height, or its estimate (the list's
	 * own, by default this one's) less its kind's usual margins.
	 */
	placeholder(row: SizedRow, estimate = this.estimate(row)): number {
		const known = this.#known(row);
		if (known) return known.box;
		const kind = this.#kinds.get(row.kind);
		const margins = kind?.rows ? kind.margins / kind.rows : 0;
		return Math.max(0, Math.round(estimate - margins));
	}

	#known(row: SizedRow) {
		const known = this.#rows.get(row.key);
		// Text wraps differently at another width: the row is measured again.
		return known &&
			this.#width !== null &&
			Math.abs(known.width - this.#width) < 1
			? known
			: undefined;
	}

	#ratio(kind: string) {
		const learned = this.#kinds.get(kind);
		if (!learned) return 1;
		const ratio =
			(learned.measured + PRIOR_PX) / (learned.estimated + PRIOR_PX);
		return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
	}
}
