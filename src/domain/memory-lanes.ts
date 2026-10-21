import {
	type MemoryRow,
	memoryEntries,
	PERSONAL_SCOPE,
	rowScope,
} from "./memory-overview";
import { memoryTokens } from "./memory-ranking";

/**
 * Memory lanes: the memory repo as its history. One lane per scope
 * (Personal, then each project), time running left to right; each line is a
 * mark on its lane at its `added:` date, a line that replaced another is
 * joined to it by a curve, and each dream is a marker across the lanes,
 * with the lines it merged converging into a merge mark. Pure; the view
 * maps days to pixels.
 */

export const NEW_DAYS = 7;
const DAY = 86_400_000;

/** Muted project colours, the same set as the sidebar's project dots. */
export const LANE_COLORS = [
	"#6b8fd6",
	"#5fae8b",
	"#c9a45a",
	"#9a83d4",
	"#cf7d93",
	"#4fa8ad",
	"#c98a5e",
	"#8a9aa8",
] as const;
export const PERSONAL_COLOR = "#a3a3a3";

/** A project's colour, picked from its id as the sidebar picks its dot colour. */
export function laneColor(key: string | null) {
	if (!key) return PERSONAL_COLOR;
	let hash = 0;
	for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return LANE_COLORS[hash % LANE_COLORS.length] as string;
}

/** Days since 1970-01-01 (UTC) for a YYYY-MM-DD date, or null. */
export function dayNumber(date: string | undefined): number | null {
	if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const ms = Date.parse(`${date}T00:00:00Z`);
	return Number.isNaN(ms) ? null : Math.round(ms / DAY);
}

export const dayDate = (day: number) =>
	new Date(day * DAY).toISOString().slice(0, 10);

export const laneNodeId = (row: Pick<MemoryRow, "path" | "line">) =>
	`${row.path}:${row.line}`;

export type LaneNode = {
	readonly id: string;
	readonly row: MemoryRow;
	readonly lane: number;
	readonly day: number;
	/** No `added:` date: drawn at the start of the range. */
	readonly undated: boolean;
	/** Position among marks on the same lane and day: 0 centre, then ±1, ±2… */
	readonly slot: number;
	readonly mark: "stated" | "inferred" | "rule";
	readonly recent: boolean;
	readonly retired: boolean;
	/** 1-based place in its version chain, and the chain's length. */
	readonly version: number;
	readonly versions: number;
	/** Every line in the same version chain, this one included. */
	readonly chain: readonly string[];
};

export type LaneCurve = {
	readonly id: string;
	readonly from: string;
	readonly to: string;
};

export type DreamMergeInput = {
	readonly into: string;
	readonly from: readonly {
		readonly text: string;
		readonly added?: string;
		readonly project?: string;
		readonly kind?: "stated" | "inferred";
	}[];
};

/** A dream as the server reports it: its commit date and what it merged. */
export type DreamInput = {
	readonly at: string;
	readonly message: string;
	readonly merges: readonly DreamMergeInput[];
};

export type LaneGhost = {
	readonly text: string;
	readonly lane: number;
	readonly day: number;
	readonly mark: "stated" | "inferred";
};

export type LaneDream = {
	readonly id: string;
	readonly day: number;
	readonly at: string;
	readonly message: string;
	readonly merges: readonly {
		readonly lane: number;
		/** The line the merge produced, when memory still holds it. */
		readonly into: string | null;
		readonly text: string;
		/** The merged lines, gone from memory, at their own dates. */
		readonly ghosts: readonly LaneGhost[];
	}[];
};

export type MemoryLanes = {
	readonly lanes: readonly {
		readonly id: string;
		readonly project: string | null;
		readonly count: number;
		/** Most marks on one day: the lane's height in slots. */
		readonly depth: number;
	}[];
	readonly nodes: readonly LaneNode[];
	readonly curves: readonly LaneCurve[];
	readonly dreams: readonly LaneDream[];
	readonly start: number;
	readonly end: number;
	readonly today: number;
};

const key = (text: string) => text.replaceAll(/\s+/g, " ").trim().toLowerCase();

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>) {
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / Math.max(1, Math.min(a.size, b.size));
}

/**
 * Older line → the line that replaced it: among lines from the chat its
 * `superseded-by` names, the one sharing the most words (any scope, so a
 * line that moved scope still chains).
 */
export function versionLinks(rows: readonly MemoryRow[]) {
	const tokens = new Map(
		rows.map((row) => [row, new Set(memoryTokens(row.text))] as const),
	);
	const next = new Map<MemoryRow, MemoryRow>();
	const taken = new Set<MemoryRow>();
	for (const older of rows) {
		const by = older.supersededBy?.toLowerCase();
		if (!by) continue;
		let best: MemoryRow | undefined;
		let score = 0;
		for (const row of rows) {
			if (row === older || taken.has(row) || row.chatId?.toLowerCase() !== by)
				continue;
			const value =
				overlap(tokens.get(older) ?? new Set(), tokens.get(row) ?? new Set()) +
				(row.path === older.path ? 0.01 : 0);
			if (value > score) {
				score = value;
				best = row;
			}
		}
		if (best) {
			next.set(older, best);
			taken.add(best);
		}
	}
	return next;
}

export function memoryLanes(input: {
	rows: readonly MemoryRow[];
	today: string;
	/** null: every scope. */
	scope: string | null;
	dreams?: readonly DreamInput[];
}): MemoryLanes {
	const today = dayNumber(input.today) ?? 0;
	const all = memoryEntries(input.rows);
	const rows = all.filter(
		(row) => input.scope === null || rowScope(row) === input.scope,
	);
	// Lanes: Personal first (when it has lines or nothing else does), projects by name.
	const projects = new Map<string, string>();
	for (const row of rows)
		if (row.project?.trim())
			projects.set(
				rowScope(row),
				projects.get(rowScope(row)) ?? row.project.trim(),
			);
	const laneIds = [
		...(rows.some((row) => rowScope(row) === PERSONAL_SCOPE) || !projects.size
			? [PERSONAL_SCOPE]
			: []),
		...[...projects.entries()]
			.sort((a, b) => a[1].localeCompare(b[1]))
			.map(([id]) => id),
	];
	const laneOf = new Map(laneIds.map((id, index) => [id, index]));
	const dated = rows
		.map((row) => dayNumber(row.added))
		.filter((day): day is number => day !== null);
	const dreamDays = (input.dreams ?? []).map((dream) =>
		Math.floor(Date.parse(dream.at) / DAY),
	);
	const ghostDays = (input.dreams ?? []).flatMap((dream) =>
		dream.merges.flatMap((merge) =>
			merge.from.flatMap((line) => {
				const day = dayNumber(line.added);
				return day === null ? [] : [day];
			}),
		),
	);
	const first = Math.min(today, ...dated, ...dreamDays, ...ghostDays);
	const start = first - 1;
	const end = Math.max(today, ...dated, ...dreamDays) + 1;

	const next = versionLinks(rows);
	const previous = new Map([...next].map(([a, b]) => [b, a]));
	const chainOf = (row: MemoryRow) => {
		let head = row;
		const seen = new Set([row]);
		for (let p = previous.get(head); p && !seen.has(p); p = previous.get(p)) {
			seen.add(p);
			head = p;
		}
		const chain = [head];
		for (let n = next.get(head); n && !chain.includes(n); n = next.get(n))
			chain.push(n);
		return chain;
	};
	const slots = new Map<string, number>();
	const depth = new Map<number, number>();
	const ordered = [...rows].sort(
		(a, b) =>
			(dayNumber(a.added) ?? start) - (dayNumber(b.added) ?? start) ||
			a.path.localeCompare(b.path) ||
			a.line - b.line,
	);
	const nodes: LaneNode[] = ordered.map((row) => {
		const lane = laneOf.get(rowScope(row)) ?? 0;
		const added = dayNumber(row.added);
		const day = added ?? start;
		const group = `${lane}:${day}`;
		const index = slots.get(group) ?? 0;
		slots.set(group, index + 1);
		depth.set(lane, Math.max(depth.get(lane) ?? 1, index + 1));
		const chain = chainOf(row);
		return {
			id: laneNodeId(row),
			row,
			lane,
			day,
			undated: added === null,
			slot: index === 0 ? 0 : index % 2 ? -Math.ceil(index / 2) : index / 2,
			mark: row.rule ? "rule" : row.kind,
			recent: added !== null && today - added <= NEW_DAYS && today >= added,
			retired: row.replaced,
			version: chain.indexOf(row) + 1,
			versions: chain.length,
			chain: chain.map(laneNodeId),
		};
	});
	const curves: LaneCurve[] = [...next].map(([older, newer]) => ({
		id: `${laneNodeId(older)}>${laneNodeId(newer)}`,
		from: laneNodeId(older),
		to: laneNodeId(newer),
	}));
	const byText = new Map(rows.map((row) => [key(row.text), row]));
	const dreams: LaneDream[] = (input.dreams ?? [])
		.map((dream, index) => ({
			id: `dream:${index}:${dream.at}`,
			day: dreamDays[index],
			at: dream.at,
			message: dream.message,
			merges: dream.merges.flatMap((merge) => {
				const into = byText.get(key(merge.into));
				const lane = into
					? laneOf.get(rowScope(into))
					: laneOf.get(
							rowScope({ project: merge.from[0]?.project ?? undefined }),
						);
				if (lane === undefined) return [];
				return [
					{
						lane,
						into: into ? laneNodeId(into) : null,
						text: merge.into,
						ghosts: merge.from.flatMap((line) => {
							const ghostLane = laneOf.get(
								rowScope({ project: line.project ?? undefined }),
							);
							if (ghostLane === undefined) return [];
							return [
								{
									text: line.text,
									lane: ghostLane,
									day: dayNumber(line.added) ?? start,
									mark: line.kind === "inferred" ? "inferred" : "stated",
								} as const,
							];
						}),
					},
				];
			}),
		}))
		.sort((a, b) => a.day - b.day);
	return {
		lanes: laneIds.map((id, index) => ({
			id,
			project: projects.get(id) ?? null,
			count: nodes.filter((node) => node.lane === index && !node.retired)
				.length,
			depth: depth.get(index) ?? 1,
		})),
		nodes,
		curves,
		dreams,
		start,
		end,
		today,
	};
}

/** Days per tick on the time axis for a given scale (pixels per day). */
export function axisStep(pixelsPerDay: number) {
	for (const step of [1, 2, 7, 14, 30, 61, 91, 182, 365])
		if (step * pixelsPerDay >= 64) return step;
	return 365;
}
