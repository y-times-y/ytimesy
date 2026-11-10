import {
	isInternalChildTaskMessage,
	isWakeTurnStart,
	turnStartTiming,
} from "./child-task-activity";
import { activityGlyphForToolName } from "./session-activity";
import {
	liveActivityStatus,
	type SessionItem,
	type SessionTurnStatus,
} from "./session-item";
import { workedLabel } from "./turn-timing";

export type ExplorationCounts = {
	readonly files: number;
	readonly searches: number;
};

export type TimelineRow =
	| { readonly kind: "item"; readonly item: SessionItem }
	| {
			readonly kind: "work";
			readonly label: string;
			readonly id: SessionItem["id"];
			readonly items: readonly SessionItem[];
	  }
	| {
			readonly kind: "exploration";
			readonly id: SessionItem["id"];
			readonly counts: ExplorationCounts;
			readonly items: readonly SessionItem[];
	  };

export function isExplorationItem(item: SessionItem): boolean {
	if (item.kind === "fileChange") return false;
	if (item.kind === "webSearch") return true;
	if (item.kind === "dynamicToolCall") {
		return isExplorationGlyph(activityGlyphForToolName(item.tool));
	}
	if (item.kind === "unknown") {
		return isExplorationGlyph(activityGlyphForToolName(item.type));
	}
	return false;
}

function explorationCounts(items: readonly SessionItem[]): ExplorationCounts {
	let files = 0;
	let searches = 0;
	for (const item of items) {
		if (item.kind === "webSearch") {
			searches += 1;
			continue;
		}
		const name =
			item.kind === "dynamicToolCall"
				? item.tool
				: item.kind === "unknown"
					? item.type
					: "";
		if (isExplorationGlyph(activityGlyphForToolName(name))) {
			if (activityGlyphForToolName(name) === "read") files += 1;
			else searches += 1;
		}
	}
	return { files, searches };
}

export function explorationLabel(counts: ExplorationCounts): string {
	const parts: string[] = [];
	if (counts.files > 0) {
		parts.push(counts.files === 1 ? "1 file" : `${counts.files} files`);
	}
	if (counts.searches > 0) {
		parts.push(
			counts.searches === 1 ? "1 search" : `${counts.searches} searches`,
		);
	}
	if (parts.length === 0) return "Explored";
	return `Explored ${parts.join(" ")}`;
}

export function explorationGroupIsLive(items: readonly SessionItem[]): boolean {
	return items.some((item) => liveActivityStatus(item) === "inProgress");
}

/**
 * The timeline's rows: each finished turn folds its work under "Worked" and
 * keeps its answer in view. `items` may hold the hidden messages that start
 * wake-up turns; they split turns and show no bubble, only a break when the
 * turn's answer would otherwise run on from the one before it.
 */
export function groupTimelineRows(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus = "running",
): TimelineRow[] {
	const rows: TimelineRow[] = [];
	let turn: SessionItem[] = [];
	let timing: { startedAt: number; completedAt?: number } | undefined;
	function flush(completed: boolean) {
		const visible = turn.filter(
			(item) =>
				item.kind !== "reasoning" ||
				item.summaries.some((summary) => summary.trim()),
		);
		if (!completed) {
			rows.push(...groupExplorationRows(turn));
			return;
		}
		const final = visible
			.filter(
				(item) => item.kind === "agentMessage" && item.phase !== "commentary",
			)
			.at(-1);
		const activity = visible.filter(
			(item) =>
				item !== final &&
				item.kind !== "fileChange" &&
				item.kind !== "error" &&
				item.kind !== "planProposal" &&
				item.kind !== "secretRequest" &&
				item.kind !== "pushApproval" &&
				item.kind !== "userQuestion" &&
				item.kind !== "memorySave" &&
				item.kind !== "modelSwitch" &&
				item.kind !== "notice",
		);
		if (activity[0])
			rows.push({
				kind: "work",
				id: activity[0].id,
				items: activity,
				label: workedLabel(timing),
			});
		// A model switch says who wrote the answer, so it stays in view above it.
		rows.push(
			...visible
				.filter((item) => item.kind === "modelSwitch")
				.map((item) => ({ kind: "item" as const, item })),
		);
		// Push approvals keep their place above the answer when work folds away.
		rows.push(
			...visible
				.filter((item) => item.kind === "pushApproval")
				.map((item) => ({ kind: "item" as const, item })),
		);
		if (final) rows.push({ kind: "item", item: final });
		// A proposed plan or secret request stays in view with its controls.
		rows.push(
			...visible
				.filter(
					(item) =>
						item.kind === "planProposal" ||
						item.kind === "secretRequest" ||
						item.kind === "userQuestion",
				)
				.map((item) => ({ kind: "item" as const, item })),
		);
		rows.push(
			...visible
				.filter((item) => item.kind === "fileChange" || item.kind === "error")
				.map((item) => ({ kind: "item" as const, item })),
		);
		// What the turn saved to memory closes it, under its answer.
		rows.push(
			...visible
				.filter((item) => item.kind === "memorySave")
				.map((item) => ({ kind: "item" as const, item })),
		);
		// Why the turn's changes stayed off GitHub, last.
		rows.push(
			...visible
				.filter((item) => item.kind === "notice")
				.map((item) => ({ kind: "item" as const, item })),
		);
	}
	// The user's reply to a question card shows in the card, not again below it.
	let questionOpen = false;
	/** Wake-up turns that start right under the previous turn's answer. */
	const wakeBreaks: { at: number; item: SessionItem }[] = [];
	for (const item of items) {
		// A wake-up turn (a helper's report, a command's exit) starts silently:
		// with a wake notice as the browser gets it (childTaskPublicItems), or
		// the stored hidden message. It ends the turn before it, so that turn's
		// answer stays in view, but shows no bubble of its own.
		if (isWakeTurnStart(item)) {
			flush(true);
			const previous = rows.at(-1);
			if (previous?.kind === "item" && previous.item.kind === "agentMessage")
				wakeBreaks.push({ at: rows.length, item });
			turn = [];
			timing = turnStartTiming(item);
			continue;
		}
		// A continued chat's handoff card stands alone, before any turn.
		if (item.kind === "handoff") {
			flush(true);
			turn = [];
			timing = undefined;
			rows.push({ kind: "item", item });
			continue;
		}
		const internal =
			item.kind === "agentMessage" && isInternalChildTaskMessage(item.text);
		if (item.kind === "userMessage") {
			flush(true);
			turn = [];
			timing = item.timing;
			if (!questionOpen) rows.push({ kind: "item", item });
			questionOpen = false;
		} else if (!internal) {
			turn.push(item);
			if (item.kind === "userQuestion") questionOpen = true;
		}
	}
	flush(turnStatus !== "running");
	// A wake-up turn whose first row is its answer (no work to fold) would
	// read as one message with the answer above it: its silent start stays
	// as a row there, which the timeline draws as a turn break.
	for (const { at, item } of wakeBreaks.reverse()) {
		const next = rows[at];
		if (next?.kind === "item" && next.item.kind === "agentMessage")
			rows.splice(at, 0, {
				kind: "item",
				item: { kind: "notice", id: item.id, message: "", wake: true },
			});
	}
	return rows;
}

export function groupExplorationRows(
	items: readonly SessionItem[],
): TimelineRow[] {
	const rows: TimelineRow[] = [];
	let index = 0;
	while (index < items.length) {
		const item = items[index];
		if (!item) break;
		if (!isExplorationItem(item)) {
			rows.push({ kind: "item", item });
			index += 1;
			continue;
		}
		const grouped: SessionItem[] = [];
		while (index < items.length) {
			const next = items[index];
			if (!next || !isExplorationItem(next)) {
				break;
			}
			grouped.push(next);
			index += 1;
		}
		const first = grouped[0];
		if (!first) continue;
		rows.push({
			kind: "exploration",
			id: first.id,
			counts: explorationCounts(grouped),
			items: grouped,
		});
	}
	return rows;
}

function isExplorationGlyph(glyph: string): boolean {
	return glyph === "search" || glyph === "read" || glyph === "web";
}
