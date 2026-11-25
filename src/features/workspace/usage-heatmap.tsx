// biome-ignore-all lint/a11y/useSemanticElements: an SVG day grid; there is no native grid element for it
// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: same grid
// biome-ignore-all lint/a11y/noAriaHiddenOnFocusable: the month and weekday text is decoration; the cells carry the labels
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	cellFill,
	type DayTokens,
	dayCell,
	formatTokens,
	type HeatmapFilter,
	levelThresholds,
	scaleMaximum,
	USAGE_LEVEL_STRENGTH,
	USAGE_PROVIDER_LABELS,
	USAGE_PROVIDERS,
} from "#/domain/usage-heatmap";
import { dayString } from "#/domain/usage-report";
import "./usage-heatmap.css";

export type HeatmapData = ReadonlyMap<
	string,
	{ tokens: DayTokens; turns: number; unknownTurns: number }
>;

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const LEFT = 26;
const TOP = 16;
const WEEKS = 53;
const DAY_MS = 86_400_000;
const WEEKDAY_LABELS: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };

const dayNumber = (day: string) =>
	Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const longDate = (day: string) =>
	new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});

type Slot = { day: string; week: number; weekday: number };

/** Weeks start on Sunday; the last column holds today. */
function slots(today: string): Slot[] {
	const end = dayNumber(today);
	const endWeekday = new Date(end * DAY_MS).getUTCDay();
	const first = end - endWeekday - (WEEKS - 1) * 7;
	const out: Slot[] = [];
	for (let n = first; n <= end; n++)
		out.push({
			day: dayString(n),
			week: Math.floor((n - first) / 7),
			weekday: (n - first) % 7,
		});
	return out;
}

type Tip = {
	day: string;
	x: number;
	y: number;
	/** Which side of the cell the tooltip grows toward, so it stays inside the panel. */
	align: "start" | "center" | "end";
};

/** Where a cell's tooltip goes, relative to the heatmap; near either edge it opens inward. */
function tipAt(cell: Element, day: string): Tip {
	const box = cell.getBoundingClientRect();
	const host = cell.closest(".usage-heatmap")?.getBoundingClientRect();
	const x = box.left - (host?.left ?? 0) + CELL / 2;
	const width = host?.width ?? 0;
	return {
		day,
		x,
		y: box.top - (host?.top ?? 0),
		align: x < width * 0.25 ? "start" : x > width * 0.75 ? "end" : "center",
	};
}

type DayData = ReturnType<HeatmapData["get"]>;

function describe(day: string, data: DayData) {
	if (!data) return `${longDate(day)}: no usage`;
	const total = USAGE_PROVIDERS.reduce((n, p) => n + (data.tokens[p] ?? 0), 0);
	const split = USAGE_PROVIDERS.filter((p) => (data.tokens[p] ?? 0) > 0)
		.map(
			(p) => `${USAGE_PROVIDER_LABELS[p]} ${formatTokens(data.tokens[p] ?? 0)}`,
		)
		.join(", ");
	return `${longDate(day)}: ${formatTokens(total)} tokens${split ? ` (${split})` : ""}, ${data.turns} ${data.turns === 1 ? "turn" : "turns"}${data.unknownTurns ? `, ${data.unknownTurns} without token counts` : ""}`;
}

/**
 * Daily token usage for the last year, one square per UTC day. Colour is the
 * day's dominant provider (All) or the chosen provider's own scale; the
 * intensity step is also printed in the legend, so colour is never the only
 * signal. Cells are a keyboard grid: one tab stop, arrow keys move by day and
 * week, and each cell carries a full text label.
 */
export function UsageHeatmap({
	data,
	today,
	filter,
}: {
	data: HeatmapData;
	today: string;
	filter: HeatmapFilter;
}) {
	const all = useMemo(() => slots(today), [today]);
	const max = useMemo(
		() =>
			scaleMaximum(
				[...data.values()].map((d) => d.tokens),
				filter,
			),
		[data, filter],
	);
	const [active, setActive] = useState(today);
	const [tip, setTip] = useState<Tip | null>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const cells = useRef(new Map<string, SVGRectElement>());

	// Show the newest weeks first on a narrow screen, before paint.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el) el.scrollLeft = el.scrollWidth;
	}, []);

	const known = new Set(all.map((s) => s.day));
	function move(day: string, by: number) {
		const next = dayString(dayNumber(day) + by);
		if (!known.has(next)) return;
		setActive(next);
		cells.current.get(next)?.focus();
	}
	const months = all
		.filter((s) => s.weekday === 0 && s.day.slice(8) <= "07")
		.map((s) => ({
			week: s.week,
			label: new Date(`${s.day}T00:00:00Z`).toLocaleDateString("en-US", {
				month: "short",
				timeZone: "UTC",
			}),
		}));
	const width = LEFT + WEEKS * STEP;
	const height = TOP + 7 * STEP;
	const [, t2, t3, t4] = [0, ...levelThresholds(max)];
	const tipData = tip ? data.get(tip.day) : undefined;

	return (
		<div className="usage-heatmap">
			<div className="usage-heatmap-scroll" ref={scroller}>
				<svg
					width={width}
					height={height}
					viewBox={`0 0 ${width} ${height}`}
					role="grid"
					aria-label="Token usage per day, last year"
				>
					<g aria-hidden="true">
						{months.map((m) => (
							<text
								key={m.week}
								x={LEFT + m.week * STEP}
								y={10}
								className="usage-heatmap-label"
							>
								{m.label}
							</text>
						))}
						{Object.entries(WEEKDAY_LABELS).map(([weekday, label]) => (
							<text
								key={label}
								x={0}
								y={TOP + Number(weekday) * STEP + CELL - 1}
								className="usage-heatmap-label"
							>
								{label}
							</text>
						))}
					</g>
					{[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
						<g key={weekday} role="row">
							{all
								.filter((s) => s.weekday === weekday)
								.map((s) => {
									const day = data.get(s.day);
									const cell = dayCell(day?.tokens, filter, max);
									return (
										<rect
											key={s.day}
											ref={(node) => {
												if (node) cells.current.set(s.day, node);
												else cells.current.delete(s.day);
											}}
											role="gridcell"
											tabIndex={s.day === active ? 0 : -1}
											aria-label={describe(s.day, day)}
											x={LEFT + s.week * STEP}
											y={TOP + weekday * STEP}
											width={CELL}
											height={CELL}
											rx={2}
											className="usage-heatmap-cell"
											data-level={cell.level}
											data-provider={cell.provider ?? undefined}
											style={{ fill: cellFill(cell) }}
											onMouseEnter={(e) => {
												setTip(tipAt(e.currentTarget, s.day));
											}}
											onMouseLeave={() => setTip(null)}
											onFocus={(e) => {
												setActive(s.day);
												setTip(tipAt(e.currentTarget, s.day));
											}}
											onBlur={() => setTip(null)}
											onKeyDown={(e) => {
												const by = {
													ArrowRight: 7,
													ArrowLeft: -7,
													ArrowDown: 1,
													ArrowUp: -1,
												}[e.key];
												if (by === undefined) return;
												e.preventDefault();
												move(s.day, by);
											}}
										/>
									);
								})}
						</g>
					))}
				</svg>
			</div>
			{tip ? (
				<div
					className="usage-heatmap-tip"
					data-align={tip.align}
					role="tooltip"
					style={{ left: tip.x, top: tip.y }}
				>
					<strong>{longDate(tip.day)}</strong>
					{tipData ? (
						<>
							<span>
								{formatTokens(
									USAGE_PROVIDERS.reduce(
										(n, p) => n + (tipData.tokens[p] ?? 0),
										0,
									),
								)}{" "}
								tokens
								{" · "}
								{tipData.turns} {tipData.turns === 1 ? "turn" : "turns"}
							</span>
							{USAGE_PROVIDERS.filter((p) => (tipData.tokens[p] ?? 0) > 0).map(
								(p) => (
									<span key={p} className="usage-heatmap-split">
										<i data-provider={p} aria-hidden="true" />
										{USAGE_PROVIDER_LABELS[p]}{" "}
										{formatTokens(tipData.tokens[p] ?? 0)}
									</span>
								),
							)}
							{tipData.unknownTurns ? (
								<span>{tipData.unknownTurns} without token counts</span>
							) : null}
						</>
					) : (
						<span>No usage</span>
					)}
				</div>
			) : null}
			<div className="usage-heatmap-legend">
				<span>Less</span>
				{[0, 1, 2, 3, 4].map((level) => (
					<i
						key={level}
						className="usage-heatmap-swatch"
						data-level={level}
						data-provider={filter === "all" ? "neutral" : filter}
						style={{
							background:
								level === 0
									? "var(--usage-cell-empty)"
									: `color-mix(in srgb, var(--usage-hue-${filter === "all" ? "neutral" : filter}) ${USAGE_LEVEL_STRENGTH[level as 1]}%, var(--usage-cell-empty))`,
						}}
					/>
				))}
				<span>More</span>
				{max > 0 ? (
					<span className="usage-heatmap-steps">
						{"· steps at "}
						{formatTokens(t2 ?? 0)}, {formatTokens(t3 ?? 0)},{" "}
						{formatTokens(t4 ?? 0)} tokens a day
					</span>
				) : null}
			</div>
		</div>
	);
}
