import { finishLineAnchorId } from "./agent-panel";
import { isWakeTurnStart, startsTurn } from "./child-task-activity";
import type { SessionItem } from "./session-item";
import type { TimelineRow } from "./timeline-activity";

/** A wake-up turn may start a moment before its report's finish is stamped. */
const CLOCK_SLACK_MS = 5_000;

export type FinishedHelper = {
	readonly id: string;
	/** The item its start line follows (childTaskAnchorId). */
	readonly start: SessionItem["id"] | undefined;
	/** When it finished (ms). */
	readonly finishedAt: number | undefined;
};

/**
 * Where each finished helper's card goes in its parent's timeline: the item
 * id it follows (an id inside one of `rows`), or null for last.
 *
 * A report wakes its parent in a turn of its own, so the card opens that
 * wake-up turn: after the turn before it, above Main's reply to the report.
 * Reports are matched to wake-up turns in finish order, each to the first
 * one that started after it finished. Until that turn starts the card goes
 * last, which is where the turn will show, so it never moves above or below
 * a reply as the chat streams or reloads.
 *
 * In the chat's own view (`reportsWake`), every report not waited for in
 * the call wakes Main. In a helper's view, a report can also arrive inside
 * a running turn; then the card goes before that turn's answer.
 */
export function helperFinishAnchors(input: {
	readonly items: readonly SessionItem[];
	readonly rows: readonly TimelineRow[];
	readonly helpers: readonly FinishedHelper[];
	readonly reportsWake: boolean;
}): Map<string, SessionItem["id"] | null> {
	const { items, rows } = input;
	const anchors = new Map<string, SessionItem["id"] | null>();
	const claimed = new Set<number>();
	const ordered = [...input.helpers].sort(
		(left, right) =>
			(left.finishedAt ?? Number.POSITIVE_INFINITY) -
			(right.finishedAt ?? Number.POSITIVE_INFINITY),
	);
	for (const helper of ordered) {
		const start = helper.start
			? items.findIndex((item) => item.id === helper.start)
			: -1;
		if (start < 0) {
			anchors.set(helper.id, null);
			continue;
		}
		const finishedAt = helper.finishedAt;
		const waited = waitedFor(items[start]);
		const wake =
			finishedAt === undefined || waited
				? -1
				: items.findIndex(
						(item, index) =>
							index > start &&
							!claimed.has(index) &&
							isWakeTurnStart(item) &&
							(turnStartedAt(item) ?? Number.NEGATIVE_INFINITY) >=
								finishedAt - CLOCK_SLACK_MS,
					);
		if (wake >= 0) {
			claimed.add(wake);
			anchors.set(helper.id, turnOpening(items, rows, wake));
			continue;
		}
		if (
			finishedAt !== undefined &&
			!waited &&
			reportStillToCome(items, start, finishedAt, input.reportsWake)
		) {
			anchors.set(helper.id, null);
			continue;
		}
		const anchor = finishLineAnchorId(items, helper.start, finishedAt);
		anchors.set(
			helper.id,
			anchor !== undefined && rowsHold(rows, anchor) ? anchor : null,
		);
	}
	return anchors;
}

/** A reader started with wait: true reports inside the call that started it. */
function waitedFor(item: SessionItem | undefined) {
	if (item?.kind !== "dynamicToolCall" || item.tool !== "agent") return false;
	try {
		return JSON.parse(item.input ?? "{}")?.wait === true;
	} catch {
		return false;
	}
}

function turnStartedAt(item: SessionItem) {
	return item.kind === "userMessage" || item.kind === "notice"
		? item.timing?.startedAt
		: undefined;
}

/**
 * True while the report's wake-up turn has not started: no turn started
 * after it finished, and (in a helper's view) the latest turn had ended
 * before it finished or is still running. Timing missing: false.
 */
function reportStillToCome(
	items: readonly SessionItem[],
	start: number,
	finishedAt: number,
	reportsWake: boolean,
) {
	let latest = -1;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item && startsTurn(item)) {
			latest = index;
			break;
		}
	}
	const latestItem = items[latest];
	const startedAt = latestItem ? turnStartedAt(latestItem) : undefined;
	if (startedAt === undefined) return false;
	if (latest > start && startedAt >= finishedAt - CLOCK_SLACK_MS) return false;
	if (reportsWake) return true;
	const completedAt =
		latestItem?.kind === "userMessage" || latestItem?.kind === "notice"
			? latestItem.timing?.completedAt
			: undefined;
	return completedAt !== undefined && finishedAt > completedAt;
}

/**
 * Where a wake-up turn opens: its own break row when it has one (a turn
 * whose first row is its answer), else after the last row of the turns
 * before it.
 */
function turnOpening(
	items: readonly SessionItem[],
	rows: readonly TimelineRow[],
	wake: number,
): SessionItem["id"] | null {
	const wakeId = items[wake]?.id;
	if (wakeId && rowsHold(rows, wakeId)) return wakeId;
	const before = new Set(items.slice(0, wake).map((item) => item.id));
	for (let index = rows.length - 1; index >= 0; index--) {
		const held = rowItemIds(rows[index]).filter((id) => before.has(id));
		if (held.length) return held.at(-1) ?? null;
	}
	return null;
}

function rowItemIds(row: TimelineRow | undefined): SessionItem["id"][] {
	if (!row) return [];
	return row.kind === "item" ? [row.item.id] : row.items.map((item) => item.id);
}

function rowsHold(rows: readonly TimelineRow[], id: SessionItem["id"]) {
	return rows.some((row) => rowItemIds(row).includes(id));
}
