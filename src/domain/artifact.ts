import { z } from "zod";

/**
 * Inline artifacts: a rich card the model writes straight into a chat
 * message as a fenced block,
 *
 *     ```artifact
 *     { "type": "stat", "stats": [{ "label": "Stars", "value": 10 }] }
 *     ```
 *
 * The block is typed JSON, never code: this module validates it with one
 * schema (unknown fields dropped, text cleaned and truncated, lists cut to
 * their limits), and the chat draws it with React from those numbers. Only
 * the `html` type carries markup, and that goes to the canvas's sandboxed
 * frame (no network, opaque origin), never into the app's page. The block
 * stays in the message text, so the transcript persists it with nothing
 * new to store, and every runner can write one with no tool.
 */
export const ARTIFACT_FENCE = "artifact";
/** The most characters of a typed spec (about 64 KB). */
export const ARTIFACT_SPEC_LIMIT = 64_000;
/** The most characters of an HTML card's markup (about 200 KB). */
export const ARTIFACT_HTML_LIMIT = 200_000;
export const ARTIFACT_LIMITS = {
	title: 80,
	label: 40,
	tabName: 24,
	cell: 120,
	text: 200,
	stats: 8,
	series: 6,
	points: 200,
	columns: 12,
	rows: 200,
	tabs: 6,
	items: 24,
	htmlHeight: { min: 120, max: 600, fallback: 320 },
} as const;

/** The series colours: the app's accent first, then restrained neutrals. */
export const ARTIFACT_SERIES_COLORS = [
	"#3b82f6",
	"#e5e5e5",
	"#8a8f98",
	"#5b6068",
	"#c9ccd1",
	"#3d4148",
] as const;

// Control characters and the bidirectional overrides that make text read
// differently from how it is stored.
const UNSAFE_TEXT =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: this strips them.
	/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const clean = (value: string, max: number) =>
	value.replace(UNSAFE_TEXT, "").trim().slice(0, max);
const text = (max: number) => z.string().transform((v) => clean(v, max));
const list = <T extends z.ZodType>(item: T, max: number, min = 0) =>
	z
		.array(item)
		.min(min)
		.transform((values) => values.slice(0, max));
const finite = z.number().finite();
const version = z.literal(1).optional();

const statItem = z.object({
	label: text(ARTIFACT_LIMITS.label),
	value: z.union([text(24), finite]),
	delta: text(16).optional(),
	note: text(80).optional(),
});

/** One typed panel; `extra` adds the fields a position needs (a title, a tab name). */
function panels<Extra extends z.ZodRawShape>(extra: Extra) {
	const chart = (type: "bar" | "line") =>
		z
			.object({
				...extra,
				type: z.literal(type),
				x: list(text(24), ARTIFACT_LIMITS.points, 1),
				series: list(
					z.object({
						name: text(ARTIFACT_LIMITS.label),
						y: list(finite, ARTIFACT_LIMITS.points, 1),
					}),
					ARTIFACT_LIMITS.series,
					1,
				),
			})
			.refine(
				(spec) => {
					// `spec` is generic in `extra`, so read the two fields it always has.
					const { x, series } = spec as unknown as {
						x: unknown[];
						series: { y: unknown[] }[];
					};
					return series.every((s) => s.y.length === x.length);
				},
				{
					message: "Every series needs one value per x label.",
				},
			);
	return [
		z.object({
			...extra,
			type: z.literal("stat"),
			stats: list(statItem, ARTIFACT_LIMITS.stats, 1),
		}),
		chart("bar"),
		chart("line"),
		z.object({
			...extra,
			type: z.literal("table"),
			columns: list(text(ARTIFACT_LIMITS.label), ARTIFACT_LIMITS.columns, 1),
			rows: list(
				list(
					z.union([text(ARTIFACT_LIMITS.cell), finite, z.null()]),
					ARTIFACT_LIMITS.columns,
				),
				ARTIFACT_LIMITS.rows,
			),
		}),
		z.object({
			...extra,
			type: z.literal("timeline"),
			events: list(
				z.object({
					label: text(80),
					at: text(24).optional(),
					detail: text(ARTIFACT_LIMITS.text).optional(),
					status: z.enum(["done", "active", "todo"]).optional(),
				}),
				ARTIFACT_LIMITS.items,
				1,
			),
		}),
		z.object({
			...extra,
			type: z.literal("checklist"),
			items: list(
				z.object({
					text: text(160),
					done: z.boolean().optional(),
				}),
				ARTIFACT_LIMITS.items,
				1,
			),
		}),
	] as const;
}

const title = { v: version, title: text(ARTIFACT_LIMITS.title).optional() };
const tab = panels({ name: text(ARTIFACT_LIMITS.tabName) });
const clamp = (height: number) =>
	Math.min(
		ARTIFACT_LIMITS.htmlHeight.max,
		Math.max(ARTIFACT_LIMITS.htmlHeight.min, Math.round(height)),
	);

const artifactSchema = z.discriminatedUnion("type", [
	...panels(title),
	z.object({
		...title,
		type: z.literal("html"),
		html: z.string().max(ARTIFACT_HTML_LIMIT),
		height: finite.transform(clamp).optional(),
	}),
	z.object({
		...title,
		type: z.literal("dashboard"),
		stats: list(statItem, ARTIFACT_LIMITS.stats).optional(),
		tabs: list(z.discriminatedUnion("type", tab), ARTIFACT_LIMITS.tabs, 1),
	}),
]);

export type Artifact = z.output<typeof artifactSchema>;
export type ArtifactPanel = Extract<
	Artifact,
	{ type: "stat" | "bar" | "line" | "table" | "timeline" | "checklist" }
>;
export type ArtifactTab = z.output<(typeof tab)[number]>;
export type ArtifactStat = z.output<typeof statItem>;
export type ArtifactChart = Extract<ArtifactPanel, { type: "bar" | "line" }>;

export type ArtifactParse =
	| { readonly status: "ready"; readonly artifact: Artifact }
	| { readonly status: "building" }
	| { readonly status: "invalid"; readonly reason: string };

/**
 * A block's source as a card. While the reply streams, JSON that has not
 * closed yet is "building" (a placeholder), never an error; once it has
 * settled, the same text is "invalid" and the chat shows it as plain code.
 */
export function parseArtifact(
	source: string,
	options: { streaming?: boolean } = {},
): ArtifactParse {
	if (source.length > ARTIFACT_HTML_LIMIT + 4_000)
		return { status: "invalid", reason: "Too large." };
	let json: unknown;
	try {
		json = JSON.parse(source);
	} catch {
		return options.streaming
			? { status: "building" }
			: { status: "invalid", reason: "Not valid JSON." };
	}
	const result = artifactSchema.safeParse(json);
	if (!result.success)
		return {
			status: "invalid",
			reason: result.error.issues[0]?.message ?? "Not a known artifact.",
		};
	if (result.data.type !== "html" && source.length > ARTIFACT_SPEC_LIMIT)
		return { status: "invalid", reason: "Too large." };
	return { status: "ready", artifact: result.data };
}

/** Whether Markdown holds an artifact fence (such a reply is drawn by the live renderer). */
export function hasArtifactFence(markdown: string): boolean {
	return /^[ \t]*(?:`{3,}|~{3,})[ \t]*artifact\b/im.test(markdown);
}

export const artifactKind = (artifact: Artifact): string =>
	artifact.type === "html"
		? "HTML"
		: artifact.type === "dashboard"
			? "Dashboard"
			: artifact.type[0].toUpperCase() + artifact.type.slice(1);

/** The few lines of system guidance every runner gets. */
export function artifactInstructions(): string {
	return `Artifacts: to show data, put a rich card straight into your reply as a fenced block whose language is artifact and whose body is one JSON object, for example:
\`\`\`artifact
{"type":"dashboard","title":"Launch, first 5 hours","stats":[{"label":"Views","value":2436},{"label":"Visitors","value":70}],"tabs":[{"name":"Traffic","type":"bar","x":["0h","1h","2h"],"series":[{"name":"Views","y":[210,640,590]}]},{"name":"Pages","type":"table","columns":["Page","Visitors"],"rows":[["/",41],["/docs",17]]}]}
\`\`\`
Types: "stat" (stats: label, value, optional delta and note; at most ${ARTIFACT_LIMITS.stats}), "bar" and "line" (x labels and series of name and y numbers, one y per x; at most ${ARTIFACT_LIMITS.series} series and ${ARTIFACT_LIMITS.points} points), "table" (columns and rows of text, numbers or null; at most ${ARTIFACT_LIMITS.columns} columns and ${ARTIFACT_LIMITS.rows} rows), "timeline" (events: label, optional at, detail and status done, active or todo), "checklist" (items: text, optional done), "dashboard" (optional stats and 1 to ${ARTIFACT_LIMITS.tabs} tabs, each a stat, bar, line, table, timeline or checklist panel with a name), and "html" (a title and one self-contained HTML document in html, up to ${Math.round(ARTIFACT_HTML_LIMIT / 1000)} KB, for anything the others cannot show; it runs sandboxed with no network, so inline all CSS, script and data). Add a short "title". Use real numbers only, never invented ones; write plain text, not Markdown or HTML, in every field except html. Use an artifact when a chart, table or checklist says it better than a paragraph: one per answer, not for decoration, and still say the conclusion in a sentence. The block must be complete valid JSON with no comments; a card that does not parse shows as code. A typed spec is at most ${Math.round(ARTIFACT_SPEC_LIMIT / 1000)} KB.`;
}

/* ---------- chart geometry (shared by the chat and the image export) ---------- */

export type ChartLayout = {
	readonly width: number;
	readonly height: number;
	readonly plot: { left: number; top: number; width: number; height: number };
	readonly ticks: readonly { y: number; label: string }[];
	readonly xLabels: readonly { x: number; label: string }[];
	readonly bars: readonly {
		series: number;
		x: number;
		y: number;
		width: number;
		height: number;
	}[];
	readonly lines: readonly {
		series: number;
		points: readonly (readonly [number, number])[];
		path: string;
	}[];
};

export const formatNumber = (value: number) =>
	value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const compact = (value: number) =>
	value.toLocaleString("en-US", {
		notation: "compact",
		maximumFractionDigits: 1,
	});
const round = (value: number) => Math.round(value * 10) / 10;

export function chartLayout(
	chart: ArtifactChart,
	width: number,
	height: number,
): ChartLayout {
	const plot = { left: 40, top: 8, width: width - 48, height: height - 32 };
	const values = chart.series.flatMap((s) => s.y);
	const high = Math.max(0, ...values);
	const low = Math.min(0, ...values);
	const range = high - low || 1;
	const yOf = (value: number) =>
		round(plot.top + plot.height * (1 - (value - low) / range));
	const count = chart.x.length;
	const step = plot.width / count;
	const ticks = [0, 1, 2, 3].map((i) => {
		const value = low + (range * i) / 3;
		return { y: yOf(value), label: compact(value) };
	});
	const every = Math.max(1, Math.ceil(count / 10));
	const xLabels = chart.x.flatMap((label, i) =>
		i % every === 0 ? [{ x: round(plot.left + step * (i + 0.5)), label }] : [],
	);
	const bars: ChartLayout["bars"][number][] = [];
	const lines: ChartLayout["lines"][number][] = [];
	chart.series.forEach((series, s) => {
		if (chart.type === "bar") {
			const group = step * 0.7;
			const barWidth = group / chart.series.length;
			series.y.forEach((value, i) => {
				const top = yOf(Math.max(value, 0));
				const bottom = yOf(Math.min(value, 0));
				bars.push({
					series: s,
					x: round(plot.left + step * i + step * 0.15 + barWidth * s),
					y: top,
					width: round(Math.max(1, barWidth - 2)),
					height: round(Math.max(1, bottom - top)),
				});
			});
		} else {
			const points = series.y.map(
				(value, i) =>
					[round(plot.left + step * (i + 0.5)), yOf(value)] as const,
			);
			lines.push({
				series: s,
				points,
				path: points
					.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`)
					.join(" "),
			});
		}
	});
	return { width, height, plot, ticks, xLabels, bars, lines };
}

/* ---------- static export: one SVG, and the document the canvas panel shows ---------- */

const esc = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
const clip = (value: string, max: number) =>
	value.length > max ? `${value.slice(0, max - 1)}…` : value;
export const statValue = (stat: ArtifactStat) =>
	typeof stat.value === "number" ? formatNumber(stat.value) : stat.value;
export const cellText = (cell: string | number | null) =>
	cell === null ? "" : typeof cell === "number" ? formatNumber(cell) : cell;

const INK = "#ededed";
const MUTED = "#939393";
const LINE = "#ffffff1f";
const FONT = "Inter, ui-sans-serif, system-ui, sans-serif";
const WIDTH = 640;
const PAD = 20;
const label = (
	x: number,
	y: number,
	value: string,
	options: {
		size?: number;
		fill?: string;
		weight?: number;
		anchor?: string;
	} = {},
) =>
	`<text x="${x}" y="${y}" font-size="${options.size ?? 12}" fill="${options.fill ?? INK}" font-weight="${options.weight ?? 400}" text-anchor="${options.anchor ?? "start"}">${esc(value)}</text>`;

type Block = { svg: string; height: number };

function statBlock(stats: readonly ArtifactStat[]): Block {
	const perRow = Math.min(4, stats.length);
	const column = (WIDTH - PAD * 2) / perRow;
	const rows = Math.ceil(stats.length / perRow);
	const svg = stats
		.map((stat, i) => {
			const x = PAD + (i % perRow) * column;
			const y = Math.floor(i / perRow) * 66;
			return `${label(x, y + 14, clip(stat.label, 26), { size: 11, fill: MUTED })}${label(x, y + 40, statValue(stat), { size: 22, weight: 600 })}${stat.delta ? label(x, y + 56, stat.delta, { size: 11, fill: ARTIFACT_SERIES_COLORS[0] }) : ""}`;
		})
		.join("");
	return { svg, height: rows * 66 + 4 };
}

function chartBlock(chart: ArtifactChart): Block {
	const layout = chartLayout(chart, WIDTH - PAD * 2, 160);
	const grid = layout.ticks
		.map(
			(tick) =>
				`<line x1="${layout.plot.left}" x2="${layout.width}" y1="${tick.y}" y2="${tick.y}" stroke="${LINE}"/>${label(layout.plot.left - 6, tick.y + 3, tick.label, { size: 10, fill: MUTED, anchor: "end" })}`,
		)
		.join("");
	const marks =
		chart.type === "bar"
			? layout.bars
					.map(
						(bar) =>
							`<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="2" fill="${ARTIFACT_SERIES_COLORS[bar.series]}"/>`,
					)
					.join("")
			: layout.lines
					.map(
						(line) =>
							`<path d="${line.path}" fill="none" stroke="${ARTIFACT_SERIES_COLORS[line.series]}" stroke-width="2" stroke-linejoin="round"/>`,
					)
					.join("");
	const xs = layout.xLabels
		.map((tick) =>
			label(tick.x, layout.height - 8, clip(tick.label, 8), {
				size: 10,
				fill: MUTED,
				anchor: "middle",
			}),
		)
		.join("");
	const legend =
		chart.series.length > 1
			? chart.series
					.map(
						(series, i) =>
							`<rect x="${PAD + i * 130}" y="172" width="8" height="8" rx="2" fill="${ARTIFACT_SERIES_COLORS[i]}"/>${label(PAD + i * 130 + 14, 180, clip(series.name, 16), { size: 11, fill: MUTED })}`,
					)
					.join("")
			: "";
	return {
		svg: `<g transform="translate(${PAD} 0)">${grid}${marks}${xs}</g>${legend}`,
		height: chart.series.length > 1 ? 192 : 172,
	};
}

function tableBlock(panel: Extract<ArtifactPanel, { type: "table" }>): Block {
	const column = (WIDTH - PAD * 2) / panel.columns.length;
	const chars = Math.max(4, Math.floor(column / 7));
	const rows = panel.rows.slice(0, 20);
	let svg = panel.columns
		.map((name, i) =>
			label(PAD + i * column, 14, clip(name, chars), { size: 11, fill: MUTED }),
		)
		.join("");
	svg += `<line x1="${PAD}" x2="${WIDTH - PAD}" y1="22" y2="22" stroke="${LINE}"/>`;
	rows.forEach((row, r) => {
		row.forEach((cell, i) => {
			svg += label(PAD + i * column, 42 + r * 22, clip(cellText(cell), chars));
		});
	});
	const more = panel.rows.length - rows.length;
	if (more > 0)
		svg += label(PAD, 42 + rows.length * 22, `+${more} more rows`, {
			size: 11,
			fill: MUTED,
		});
	return { svg, height: 30 + (rows.length + (more > 0 ? 1 : 0)) * 22 };
}

function timelineBlock(
	panel: Extract<ArtifactPanel, { type: "timeline" }>,
): Block {
	const svg = panel.events
		.map((event, i) => {
			const y = i * 30;
			const fill =
				event.status === "done"
					? ARTIFACT_SERIES_COLORS[0]
					: event.status === "active"
						? INK
						: "none";
			return `<circle cx="${PAD + 4}" cy="${y + 8}" r="4" fill="${fill}" stroke="${fill === "none" ? MUTED : fill}"/>${label(PAD + 18, y + 12, clip(event.label, 60))}${event.at ? label(WIDTH - PAD, y + 12, event.at, { size: 11, fill: MUTED, anchor: "end" }) : ""}`;
		})
		.join("");
	return { svg, height: panel.events.length * 30 };
}

function checklistBlock(
	panel: Extract<ArtifactPanel, { type: "checklist" }>,
): Block {
	const svg = panel.items
		.map((item, i) => {
			const y = i * 26;
			return `<rect x="${PAD}" y="${y}" width="12" height="12" rx="3" fill="${item.done ? ARTIFACT_SERIES_COLORS[0] : "none"}" stroke="${item.done ? ARTIFACT_SERIES_COLORS[0] : MUTED}"/>${item.done ? `<path d="M${PAD + 3} ${y + 6} l2.5 2.5 l4 -5" fill="none" stroke="#fff" stroke-width="1.6"/>` : ""}${label(PAD + 22, y + 11, clip(item.text, 70), { fill: item.done ? MUTED : INK })}`;
		})
		.join("");
	return { svg, height: panel.items.length * 26 };
}

function panelBlock(panel: ArtifactPanel | ArtifactTab): Block {
	switch (panel.type) {
		case "stat":
			return statBlock(panel.stats);
		case "bar":
		case "line":
			return chartBlock(panel);
		case "table":
			return tableBlock(panel);
		case "timeline":
			return timelineBlock(panel);
		case "checklist":
			return checklistBlock(panel);
	}
}

/** The artifact as one standalone SVG (every tab stacked), for Copy as image and Expand. */
export function artifactSvg(artifact: Artifact): string {
	if (artifact.type === "html") return "";
	let y = 0;
	let body = "";
	const place = (block: Block, gap = 16) => {
		body += `<g transform="translate(0 ${y})">${block.svg}</g>`;
		y += block.height + gap;
	};
	const heading = artifact.title || artifactKind(artifact);
	body += label(PAD, 34, clip(heading, 70), { size: 16, weight: 600 });
	y = 56;
	if (artifact.type === "dashboard") {
		if (artifact.stats?.length) place(statBlock(artifact.stats));
		for (const tab of artifact.tabs) {
			place(
				{
					svg: `${label(PAD, 12, tab.name, { size: 12, weight: 600 })}<line x1="${PAD}" x2="${WIDTH - PAD}" y1="20" y2="20" stroke="${LINE}"/>`,
					height: 24,
				},
				8,
			);
			place(panelBlock(tab));
		}
	} else place(panelBlock(artifact));
	const height = Math.ceil(y + 8);
	const summary = esc(clip(heading, 120));
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${summary}" font-family="${FONT}"><title>${summary}</title><rect width="${WIDTH}" height="${height}" rx="12" fill="#141414"/>${body}</svg>`;
}

/**
 * What the canvas panel shows for an expanded artifact: an HTML card's own
 * markup (the panel's frame sandboxes it), or a static page around the
 * SVG, with no script and nothing to load.
 */
export function artifactDocument(artifact: Artifact): string {
	if (artifact.type === "html") return artifact.html;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(artifact.title || artifactKind(artifact))}</title><style>body{margin:0;padding:24px;background:#080808;color:#ededed}svg{display:block;width:100%;max-width:960px;height:auto;margin:0 auto}</style></head><body>${artifactSvg(artifact)}</body></html>`;
}
