import {
	defaultRangeExtractor,
	type Range,
	useVirtualizer,
	type VirtualItem,
} from "@tanstack/react-virtual";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useHydrated } from "../app/first-paint";

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

/** Within this distance of the end (px) the list follows new rows down. */
const FOLLOW_END_PX = 64;

/** How near the top (px) the reader is when onNearStart asks for more. */
const NEAR_START_PX = 1_200;

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
}) {
	const id = useId();
	const listRef = useRef<HTMLOListElement>(null);
	const hydrated = useHydrated();
	// Hydrating: the server's rows are laid out already. The list starts from
	// their real heights and scroll position, so taking over moves nothing.
	const [serverLayout] = useState(() => readServerLayout(id, entries));
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
		estimateSize: (index) => entries[index]?.estimate ?? 40,
		getItemKey: (index) => entries[index]?.key ?? index,
		measureElement: rowHeight,
		rangeExtractor,
		overscan: OVERSCAN,
		paddingStart: PADDING_START + (first?.height ?? 0),
		paddingEnd: PADDING_END,
		// The server lays the list out as a tall screen would.
		initialRect: { width: 720, height: 1_000 },
		initialOffset: () =>
			serverLayout?.scrollTop ??
			(followEnd
				? entries.reduce((total, entry) => total + entry.estimate, 0)
				: 0),
		initialMeasurementsCache: serverLayout?.sizes,
		anchorTo: "end",
		followOnAppend: followEnd,
		scrollEndThreshold: FOLLOW_END_PX,
	});
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
				virtualizer.resizeItem(Number(row.dataset.index), rowHeight(row));
		},
		[virtualizer],
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
	for (const row of rows) {
		const entry = entries[row.index];
		if (!entry) continue;
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
			>
				{entry.content}
			</li>,
		);
		laidOut = row.end;
	}
	const rest = virtualizer.getTotalSize() - PADDING_END - laidOut;
	if (rest > 0.5) children.push(spacer("space:end", rest));

	return (
		<ol ref={listRef} id={id} className="session-timeline" aria-label="Session">
			{children}
		</ol>
	);
}

/** Room for rows not mounted. */
function spacer(key: string, height: number) {
	return <li key={key} aria-hidden="true" style={{ height, flex: "none" }} />;
}

/** A row's height with its margins: rows sit edge to edge in the list's flow. */
function rowHeight(element: Element) {
	const style = getComputedStyle(element);
	return (
		element.getBoundingClientRect().height +
		Number.parseFloat(style.marginTop) +
		Number.parseFloat(style.marginBottom)
	);
}

/** The server-rendered list this hydrating one takes over: its rows' heights and its scroll position. */
function readServerLayout(
	id: string,
	entries: readonly TranscriptEntry[],
): { scrollTop: number; sizes: VirtualItem[] } | null {
	if (typeof document === "undefined") return null;
	const list = document.getElementById(id);
	if (!(list instanceof HTMLOListElement)) return null;
	const sizes: VirtualItem[] = [];
	for (const row of list.querySelectorAll<HTMLElement>(
		":scope > li[data-index]",
	)) {
		const index = Number(row.dataset.index);
		const key = entries[index]?.key;
		if (key === undefined || key !== row.dataset.key) continue;
		const size = rowHeight(row);
		sizes.push({ index, key, start: 0, size, end: size, lane: 0 });
	}
	return { scrollTop: list.scrollTop, sizes };
}
