import {
	defaultRangeExtractor,
	type Range,
	useVirtualizer,
	type VirtualItem,
	type Virtualizer,
} from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { TIMELINE_END_SCRIPT, useHydrated } from "../app/first-paint";
import { type RowHeight, RowHeights } from "./transcript-row-heights";

/** One row of a transcript list. */
export type TranscriptEntry = {
	readonly key: string;
	/** What the row shows (data-kind; styles key on it). */
	readonly kind: string;
	/**
	 * The kind of the row before it (data-follows): spacing that depends on
	 * the row above reads this, so it holds when that row is not mounted.
	 */
	readonly follows?: string;
	/** The timeline row it shows (data-row). */
	readonly row?: string;
	/** A message still waiting behind the running turn. */
	readonly queued?: boolean;
	/** Its height (px, with margins) until it is measured. */
	readonly estimate: number;
	readonly content: ReactNode;
};

/**
 * The newest rows stay mounted wherever the reader is: the server paints
 * them (enough to fill a tall screen), and the browser's find (Ctrl+F) finds
 * the recent context in them. Older rows mount as they near the view.
 */
export const MOUNTED_END_ROWS = 40;

/** Rows mounted beyond each edge of the view. */
const OVERSCAN = 8;

/** The list's own padding (.session-timeline in session-composer.css). */
const PADDING_START = 4;
const PADDING_END = 16;

/** Within this distance of the end (px) the reader is back at the end, and the list follows again. */
const AT_END_PX = 4;

/** How near the top (px) the reader is when onNearStart asks for more. */
const NEAR_START_PX = 1_200;

/**
 * Row heights learned in this tab, shared by every transcript list: a page
 * of older turns, or a chat opened again, starts from them.
 */
const rowHeights = new RowHeights();

/**
 * A transcript as a list that mounts only the rows near the view (and its
 * newest rows). It sits at its end when it opens and follows new rows only
 * while the reader is at the end; rows added above (older turns) or rows
 * that change height above the view leave the row being read in place.
 */
export function VirtualTranscript({
	entries,
	first,
	followEnd = true,
	onNearStart,
	followKey,
}: {
	entries: readonly TranscriptEntry[];
	/**
	 * A fixed-height row above the entries (the older turns' loading row).
	 * It is not an entry: the row being read is never it, so rows added
	 * below it keep the reader in place.
	 */
	first?: {
		readonly kind: string;
		readonly height: number;
		readonly content: ReactNode;
	};
	/** Open at the end and follow new rows while the reader is there. */
	followEnd?: boolean;
	/** The reader is near the top: rows before the first may be added. */
	onNearStart?: () => void;
	/**
	 * Changes when the reader sends a message: the list goes back to its
	 * end and follows again, wherever the reader was.
	 */
	followKey?: string;
}) {
	const id = useId();
	const listRef = useRef<HTMLOListElement>(null);
	const hydrated = useHydrated();
	// Hydrating: the server's rows are laid out already. The list starts from
	// their real heights and scroll position, so taking over moves nothing.
	const [serverLayout] = useState(() => readServerLayout(id, entries));
	// Following: the list keeps its end in view as rows are added or grow.
	// Scrolling up stops it; scrolling back to the end, the jump button or
	// sending a message starts it again.
	const following = useRef(followEnd);
	const [awayFromEnd, setAwayFromEnd] = useState(false);
	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	// A row's estimate holds once given, until the row is measured: the
	// virtualizer re-reads estimates at every render, and rows not mounted
	// above the reader would otherwise move as estimates are learned. Rows
	// first seen later (a page of older turns) start from what was learned.
	const estimates = useRef(new Map<string, number>());
	const estimate = (entry: TranscriptEntry) => {
		let height = estimates.current.get(entry.key);
		if (height === undefined) {
			height = rowHeights.estimate(entry);
			estimates.current.set(entry.key, height);
		}
		return height;
	};
	// Each mounted row's room while the browser skips laying it out, chosen
	// as it mounts: if it followed the estimates as they are learned, a row
	// never rendered would change height above the reader at every render.
	const placeholders = useRef(new Map<string, number>());
	// A rendered row's height, remembered for when it or its kind is not
	// mounted. A row the browser skips measures as the room it was given.
	const measure = useCallback((element: Element) => {
		const height = rowHeight(element);
		const row = element as HTMLElement;
		const entry = entriesRef.current[Number(row.dataset.index)];
		const list = listRef.current;
		if (entry?.key === row.dataset.key && list && !layoutSkipped(row))
			rowHeights.measured(entry, height, list.clientWidth);
		return height.box + height.margins;
	}, []);
	const lastScrollTop = useRef<number | null>(null);
	const rangeExtractor = useCallback(
		(range: Range) => {
			const newest = Math.max(0, range.count - MOUNTED_END_ROWS);
			const end = Array.from(
				{ length: range.count - newest },
				(_, index) => newest + index,
			);
			// The server and the hydrating page render exactly the newest rows.
			if (!hydrated) return end;
			return [...new Set([...defaultRangeExtractor(range), ...end])].sort(
				(a, b) => a - b,
			);
		},
		[hydrated],
	);
	const virtualizer = useVirtualizer({
		count: entries.length,
		getScrollElement: () => listRef.current,
		estimateSize: (index) => {
			const entry = entries[index];
			return entry ? estimate(entry) : 40;
		},
		getItemKey: (index) => entries[index]?.key ?? index,
		measureElement: measure,
		rangeExtractor,
		overscan: OVERSCAN,
		paddingStart: PADDING_START + (first?.height ?? 0),
		paddingEnd: PADDING_END,
		// The server lays the list out as a tall screen would.
		initialRect: { width: 720, height: 1_000 },
		initialOffset: () =>
			serverLayout?.scrollTop ??
			(followEnd
				? entries.reduce((total, entry) => total + estimate(entry), 0)
				: 0),
		initialMeasurementsCache: serverLayout?.sizes,
		anchorTo: "end",
		followOnAppend: followEnd,
		// While following, any growth keeps the end in view; otherwise none.
		scrollEndThreshold:
			followEnd && !awayFromEnd ? Number.POSITIVE_INFINITY : 0,
	});
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = keepRowsAboveInPlace;
	const follow = useCallback(
		(smooth: boolean) => {
			following.current = true;
			setAwayFromEnd(false);
			const list = listRef.current;
			const distance = list ? distanceFromEnd(list) : 0;
			virtualizer.scrollToEnd({
				behavior: smooth && distance < SMOOTH_JUMP_MAX_PX ? "smooth" : "auto",
			});
		},
		[virtualizer],
	);
	const onScroll = useCallback(() => {
		const list = listRef.current;
		if (!list || !followEnd) return;
		const top = list.scrollTop;
		const movedUp =
			lastScrollTop.current !== null && top < lastScrollTop.current - 1;
		lastScrollTop.current = top;
		const atEnd = distanceFromEnd(list) <= AT_END_PX;
		// The list's own corrections only move it down, or keep it at the
		// end when rows shrink: moving up away from the end is the reader.
		const next = atEnd || (following.current && !movedUp);
		if (next === following.current) return;
		following.current = next;
		setAwayFromEnd(!next);
	}, [followEnd]);
	// Rows replaced at the end (the "Thinking" line by the reply) are not an
	// append the virtualizer follows: keep the end in view after each render.
	useLayoutEffect(() => {
		const list = listRef.current;
		if (!list || !followEnd || !hydrated || !following.current) return;
		if (distanceFromEnd(list) > 1) list.scrollTop = list.scrollHeight;
		// Where the list keeps itself: the reader's first move up from here
		// stops following, even when no scroll event came before it.
		lastScrollTop.current = list.scrollTop;
	});
	const sentKey = useRef(followKey);
	useLayoutEffect(() => {
		if (sentKey.current === followKey) return;
		sentKey.current = followKey;
		if (followEnd && !following.current) follow(false);
	}, [followKey, followEnd, follow]);
	// The list keeps its own place (it opens at its end). The router's scroll
	// restoration matches lists by their CSS path, which every chat's list
	// shares, so it put this one where the last chat's was (its top) after
	// it opened; under an id of its own, no saved position matches it.
	useLayoutEffect(() => {
		listRef.current?.setAttribute(
			"data-scroll-restoration-id",
			`transcript-${Math.random().toString(36).slice(2)}`,
		);
	}, []);
	// The server's rows painted at their real heights: they keep them when
	// the browser starts skipping the ones away from the view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, as the list hydrates.
	useLayoutEffect(() => {
		for (const { entry, height } of serverLayout?.rows ?? [])
			rowHeights.measured(entry, height, serverLayout?.width ?? 0);
	}, []);
	// Opened in the browser (another chat): at the end, as the server's paints.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, when the list mounts.
	useLayoutEffect(() => {
		if (!serverLayout && followEnd && entries.length) virtualizer.scrollToEnd();
	}, []);
	// A row is measured as it mounts, even mid-scroll (the virtualizer would
	// wait for its resize observer): the room it took above the view is
	// corrected before the browser lays the frame out, so nothing shifts.
	const measureRow = useCallback(
		(row: HTMLLIElement | null) => {
			virtualizer.measureElement(row);
			if (row?.isConnected)
				virtualizer.resizeItem(Number(row.dataset.index), measure(row));
		},
		[virtualizer, measure],
	);
	const rows = virtualizer.getVirtualItems();
	const scrollOffset = virtualizer.scrollOffset;
	useEffect(() => {
		if (
			hydrated &&
			onNearStart &&
			(rows[0]?.index === 0 || (scrollOffset ?? 0) < NEAR_START_PX)
		)
			onNearStart();
	});

	const children: ReactNode[] = [];
	if (first)
		children.push(
			<li
				key="first"
				data-kind={first.kind}
				aria-hidden={first.content == null ? true : undefined}
			>
				{first.content}
			</li>,
		);
	let laidOut = PADDING_START + (first?.height ?? 0);
	const mounted = new Map<string, number>();
	const viewHeight = virtualizer.scrollRect?.height ?? 0;
	const viewTop = scrollOffset ?? 0;
	for (const row of rows) {
		const entry = entries[row.index];
		if (!entry) continue;
		// The server paints the estimate and the hydrating page matches it;
		// rows are only skipped once hydrated, by then with their real height.
		// Once measured, its real height; before, the guess chosen as it mounted.
		const measuredRow = hydrated && rowHeights.hasMeasured(entry);
		const placeholder = !hydrated
			? entry.estimate
			: measuredRow
				? rowHeights.placeholder(entry)
				: (placeholders.current.get(entry.key) ??
					rowHeights.placeholder(entry, estimate(entry)));
		if (hydrated) mounted.set(entry.key, placeholder);
		// Only a row well away from the view may skip layout: the browser
		// starts every row it newly may skip with its content skipped for a
		// frame, so the rows in view (the newest, at hydration) would flash
		// in and shift. A row near the view is laid out, so one nearing it
		// is already there; a view of unknown size skips none.
		// ...and only one whose real height is known: a row skipped before it
		// was ever rendered keeps an estimate, and jumps when it is laid out
		// on nearing the view. An unmeasured row renders once, is measured,
		// and may skip from then on.
		const away =
			hydrated && rowAwayFromView(row, viewTop, viewHeight) && measuredRow;
		if (row.start - laidOut > 0.5)
			children.push(spacer(`space:${row.index}`, row.start - laidOut));
		children.push(
			<li
				key={entry.key}
				ref={measureRow}
				data-index={row.index}
				data-key={entry.key}
				data-kind={entry.kind}
				data-row={entry.row}
				data-follows={entry.follows}
				data-queued={entry.queued ? "true" : undefined}
				data-away={away ? "" : undefined}
				// The room it keeps while the browser skips laying it out (see
				// data-skip-offscreen): once rendered, its own last height.
				style={{ containIntrinsicSize: `auto ${placeholder}px` }}
			>
				{entry.content}
			</li>,
		);
		laidOut = row.end;
	}
	placeholders.current = mounted;
	const rest = virtualizer.getTotalSize() - PADDING_END - laidOut;
	if (rest > 0.5) children.push(spacer("space:end", rest));

	return (
		<>
			<ol
				ref={listRef}
				id={id}
				className="session-timeline"
				aria-label="Session"
				// Rows away from the view (data-away) skip layout
				// (session-composer.css), once the server's rows have painted at
				// their real heights.
				data-skip-offscreen={hydrated ? "" : undefined}
				onScroll={followEnd ? onScroll : undefined}
			>
				{children}
			</ol>
			{followEnd && !hydrated ? (
				// The server's transcript paints scrolled to its end, where the list keeps it.
				<script
					// biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant script, no user input.
					dangerouslySetInnerHTML={{ __html: TIMELINE_END_SCRIPT }}
					suppressHydrationWarning
				/>
			) : null}
			{followEnd ? (
				// No height: the button floats over the composer's top edge.
				<div className="timeline-jump">
					{awayFromEnd ? (
						<button
							type="button"
							aria-label="Jump to latest"
							title="Jump to latest"
							onClick={() => follow(true)}
						>
							<ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" />
						</button>
					) : null}
				</div>
			) : null}
		</>
	);
}

/** Farther than this (px), the jump button moves at once instead of scrolling smoothly. */
const SMOOTH_JUMP_MAX_PX = 2_400;

function distanceFromEnd(list: HTMLElement) {
	return list.scrollHeight - list.scrollTop - list.clientHeight;
}

/** Room for rows not mounted. */
function spacer(key: string, height: number) {
	return <li key={key} aria-hidden="true" style={{ height, flex: "none" }} />;
}

/** A row's height and its margins: rows sit edge to edge in the list's flow. */
function rowHeight(element: Element): RowHeight {
	const style = getComputedStyle(element);
	return {
		box: element.getBoundingClientRect().height,
		margins:
			Number.parseFloat(style.marginTop) +
			Number.parseFloat(style.marginBottom),
	};
}

/** The browser skips laying out the row's content (content-visibility: auto, away from the view). */
function layoutSkipped(row: HTMLElement) {
	const content = row.firstElementChild;
	return (
		content !== null &&
		typeof content.checkVisibility === "function" &&
		!content.checkVisibility({ contentVisibilityAuto: true })
	);
}

/**
 * Whether a row is far enough from the view to skip layout: wholly more than
 * a view's height beyond either edge. A view of unknown size (0) skips none.
 */
export function rowAwayFromView(
	row: { readonly start: number; readonly end: number },
	viewTop: number,
	viewHeight: number,
) {
	return (
		viewHeight > 0 &&
		(row.end < viewTop - viewHeight || row.start > viewTop + 2 * viewHeight)
	);
}

/**
 * Which row size changes move the view, so the row being read stays in
 * place: a row's first measurement when it starts above the view, and any
 * later change of a row wholly above it, whichever way the reader scrolls.
 * The virtualizer's own rule leaves out the latter while scrolling up, but
 * that is exactly when a row the browser skipped lays out, as it nears the
 * view from above.
 */
export function keepRowsAboveInPlace(
	item: VirtualItem,
	_delta: number,
	instance: Virtualizer<HTMLOListElement, Element>,
) {
	const top = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
	return instance.itemSizeCache.has(item.key)
		? item.end <= top
		: item.start < top;
}

/** The server-rendered list this hydrating one takes over: its rows' heights and its scroll position. */
function readServerLayout(
	id: string,
	entries: readonly TranscriptEntry[],
): {
	scrollTop: number;
	sizes: VirtualItem[];
	rows: { entry: TranscriptEntry; height: RowHeight }[];
	width: number;
} | null {
	if (typeof document === "undefined") return null;
	const list = document.getElementById(id);
	if (!(list instanceof HTMLOListElement)) return null;
	const sizes: VirtualItem[] = [];
	const rows: { entry: TranscriptEntry; height: RowHeight }[] = [];
	for (const row of list.querySelectorAll<HTMLElement>(
		":scope > li[data-index]",
	)) {
		const index = Number(row.dataset.index);
		const entry = entries[index];
		if (!entry || entry.key !== row.dataset.key) continue;
		const height = rowHeight(row);
		const size = height.box + height.margins;
		sizes.push({ index, key: entry.key, start: 0, size, end: size, lane: 0 });
		rows.push({ entry, height });
	}
	return { scrollTop: list.scrollTop, sizes, rows, width: list.clientWidth };
}
