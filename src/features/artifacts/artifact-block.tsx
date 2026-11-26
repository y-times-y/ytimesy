import { Check, Copy, Download, Maximize2 } from "lucide-react";
import {
	Component,
	type KeyboardEvent,
	type ReactNode,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	ARTIFACT_LIMITS,
	ARTIFACT_SERIES_COLORS,
	type Artifact,
	type ArtifactChart,
	type ArtifactPanel,
	type ArtifactStat,
	type ArtifactTab,
	artifactDocument,
	artifactKind,
	artifactSvg,
	cellText,
	chartLayout,
	formatNumber,
	parseArtifact,
	statValue,
} from "#/domain/artifact";
import { CanvasFrame } from "../canvas/canvas-frame";
import { useCanvasOpener } from "../canvas/canvas-open-context";
import { artifactPngBlob, copyPng, downloadPng } from "./artifact-image";
import "./artifact.css";

/**
 * An artifact block in a reply (src/domain/artifact.ts). Still streaming and
 * not yet valid JSON: a placeholder. Settled and not valid: `fallback` (the
 * source as code). Valid: the card. A card that fails to draw falls back
 * too, so one block never breaks the message around it.
 */
export function ArtifactBlock({
	source,
	streaming,
	fallback,
}: {
	source: string;
	streaming: boolean;
	fallback: ReactNode;
}) {
	const parsed = useMemo(
		() => parseArtifact(source, { streaming }),
		[source, streaming],
	);
	if (parsed.status === "building")
		return (
			<figure
				className="artifact artifact-building"
				aria-busy="true"
				aria-label="Building an artifact"
			>
				<div className="artifact-skeleton" aria-hidden="true">
					<i />
					<i />
					<i />
				</div>
			</figure>
		);
	if (parsed.status === "invalid") return <>{fallback}</>;
	return (
		<ArtifactBoundary fallback={fallback}>
			<ArtifactCard artifact={parsed.artifact} />
		</ArtifactBoundary>
	);
}

class ArtifactBoundary extends Component<
	{ children: ReactNode; fallback: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
	const open = useCanvasOpener();
	const heading = artifact.title || artifactKind(artifact);
	const [status, setStatus] = useState("");
	const busy = useRef(false);
	const image = async (mode: "copy" | "download") => {
		if (busy.current || artifact.type === "html") return;
		busy.current = true;
		try {
			const blob = await artifactPngBlob(artifactSvg(artifact));
			if (mode === "copy" && (await copyPng(blob))) setStatus("Copied image");
			else {
				downloadPng(blob, heading);
				setStatus("Saved image");
			}
		} catch {
			setStatus("Could not make the image");
		} finally {
			busy.current = false;
			window.setTimeout(() => setStatus(""), 2_500);
		}
	};
	return (
		<figure className="artifact" data-kind={artifact.type}>
			<figcaption className="artifact-head">
				<strong className="artifact-title" title={heading}>
					{heading}
				</strong>
				<span className="artifact-kind">{artifactKind(artifact)}</span>
				<span className="artifact-actions">
					{artifact.type !== "html" ? (
						<>
							<button
								type="button"
								aria-label="Copy as image"
								title="Copy as image"
								onClick={() => void image("copy")}
							>
								{status === "Copied image" ? (
									<Check size={14} strokeWidth={1.75} />
								) : (
									<Copy size={14} strokeWidth={1.75} />
								)}
							</button>
							<button
								type="button"
								aria-label="Download as image"
								title="Download as image"
								onClick={() => void image("download")}
							>
								<Download size={14} strokeWidth={1.75} />
							</button>
						</>
					) : null}
					{open ? (
						<button
							type="button"
							aria-label="Expand to the canvas panel"
							title="Expand to the canvas panel"
							onClick={() =>
								open({
									title: `Artifact · ${heading}`.slice(0, 60),
									document: artifactDocument(artifact),
								})
							}
						>
							<Maximize2 size={14} strokeWidth={1.75} />
						</button>
					) : null}
				</span>
				<span className="sr-only" role="status" aria-live="polite">
					{status}
				</span>
			</figcaption>
			{artifact.type === "html" ? (
				<CanvasFrame
					html={artifact.html}
					title={heading}
					className="artifact-frame"
					lazy
				/>
			) : artifact.type === "dashboard" ? (
				<Dashboard artifact={artifact} />
			) : (
				<Panel panel={artifact} />
			)}
		</figure>
	);
}

function Dashboard({
	artifact,
}: {
	artifact: Extract<Artifact, { type: "dashboard" }>;
}) {
	const id = useId();
	const [selected, setSelected] = useState(0);
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const tabs = artifact.tabs;
	const current = tabs[Math.min(selected, tabs.length - 1)];
	const move = (event: KeyboardEvent, index: number) => {
		const next =
			event.key === "ArrowRight"
				? (index + 1) % tabs.length
				: event.key === "ArrowLeft"
					? (index - 1 + tabs.length) % tabs.length
					: event.key === "Home"
						? 0
						: event.key === "End"
							? tabs.length - 1
							: null;
		if (next === null) return;
		event.preventDefault();
		setSelected(next);
		buttons.current[next]?.focus();
	};
	return (
		<>
			{artifact.stats?.length ? <Stats stats={artifact.stats} /> : null}
			<div className="artifact-tabs" role="tablist" aria-label="Views">
				{tabs.map((tab, index) => (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: tabs are a fixed list for this render.
						key={index}
						ref={(element) => {
							buttons.current[index] = element;
						}}
						type="button"
						role="tab"
						id={`${id}-tab-${index}`}
						aria-selected={tab === current}
						aria-controls={`${id}-panel`}
						tabIndex={tab === current ? 0 : -1}
						onClick={() => setSelected(index)}
						onKeyDown={(event) => move(event, index)}
					>
						{tab.name || `View ${index + 1}`}
					</button>
				))}
			</div>
			<div
				role="tabpanel"
				id={`${id}-panel`}
				aria-labelledby={`${id}-tab-${tabs.indexOf(current)}`}
				className="artifact-body"
			>
				<Panel panel={current} />
			</div>
		</>
	);
}

function Panel({ panel }: { panel: ArtifactPanel | ArtifactTab }) {
	switch (panel.type) {
		case "stat":
			return <Stats stats={panel.stats} />;
		case "bar":
		case "line":
			return <Chart chart={panel} />;
		case "table":
			return <Table panel={panel} />;
		case "timeline":
			return (
				<ol className="artifact-timeline artifact-body">
					{panel.events.map((event, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
						<li key={index} data-status={event.status ?? "todo"}>
							<span className="artifact-dot" aria-hidden="true" />
							<span className="artifact-event">
								<span>{event.label}</span>
								{event.detail ? <small>{event.detail}</small> : null}
							</span>
							{event.at ? <time>{event.at}</time> : null}
							{event.status ? (
								<span className="sr-only"> ({event.status})</span>
							) : null}
						</li>
					))}
				</ol>
			);
		case "checklist":
			return (
				<ul className="artifact-checklist artifact-body">
					{panel.items.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
						<li key={index} data-done={item.done ? "true" : undefined}>
							<input
								type="checkbox"
								checked={Boolean(item.done)}
								disabled
								readOnly
							/>
							<span>{item.text}</span>
						</li>
					))}
				</ul>
			);
	}
}

function Stats({ stats }: { stats: readonly ArtifactStat[] }) {
	return (
		<dl className="artifact-stats">
			{stats.map((stat, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
				<div key={index}>
					<dt>{stat.label}</dt>
					<dd>
						{statValue(stat)}
						{stat.delta ? <small>{stat.delta}</small> : null}
					</dd>
					{stat.note ? <dd className="artifact-note">{stat.note}</dd> : null}
				</div>
			))}
		</dl>
	);
}

const CHART = { width: 560, height: 176 } as const;

function Chart({ chart }: { chart: ArtifactChart }) {
	const layout = chartLayout(chart, CHART.width, CHART.height);
	const summary =
		`${chart.type === "bar" ? "Bar" : "Line"} chart: ${chart.series
			.map(
				(series) =>
					`${series.name}: ${chart.x.map((x, i) => `${x} ${formatNumber(series.y[i])}`).join(", ")}`,
			)
			.join("; ")}`.slice(0, 400);
	return (
		<div className="artifact-body">
			<svg
				className="artifact-chart"
				viewBox={`0 0 ${CHART.width} ${CHART.height}`}
				role="img"
				aria-label={summary}
			>
				{layout.ticks.map((tick) => (
					<g key={tick.y}>
						<line
							x1={layout.plot.left}
							x2={CHART.width}
							y1={tick.y}
							y2={tick.y}
							className="artifact-grid"
						/>
						<text
							x={layout.plot.left - 6}
							y={tick.y + 3}
							textAnchor="end"
							className="artifact-axis"
						>
							{tick.label}
						</text>
					</g>
				))}
				{layout.bars.map((bar) => (
					<rect
						key={`${bar.series}:${bar.x}`}
						x={bar.x}
						y={bar.y}
						width={bar.width}
						height={bar.height}
						rx={2}
						fill={ARTIFACT_SERIES_COLORS[bar.series]}
					/>
				))}
				{layout.lines.map((line) => (
					<g key={line.series}>
						<path
							d={line.path}
							fill="none"
							stroke={ARTIFACT_SERIES_COLORS[line.series]}
							strokeWidth={2}
							strokeLinejoin="round"
						/>
						{line.points.length <= 40
							? line.points.map(([x, y]) => (
									<circle
										key={x}
										cx={x}
										cy={y}
										r={2.5}
										fill={ARTIFACT_SERIES_COLORS[line.series]}
									/>
								))
							: null}
					</g>
				))}
				{layout.xLabels.map((tick) => (
					<text
						key={tick.x}
						x={tick.x}
						y={CHART.height - 8}
						textAnchor="middle"
						className="artifact-axis"
					>
						{tick.label.length > 10 ? `${tick.label.slice(0, 9)}…` : tick.label}
					</text>
				))}
			</svg>
			{chart.series.length > 1 ? (
				<ul className="artifact-legend">
					{chart.series.map((series, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
						<li key={index}>
							<i style={{ background: ARTIFACT_SERIES_COLORS[index] }} />
							{series.name}
						</li>
					))}
				</ul>
			) : null}
			<table className="sr-only">
				<caption>{summary.split(":")[0]} data</caption>
				<thead>
					<tr>
						<th scope="col">Label</th>
						{chart.series.map((series, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
							<th key={index} scope="col">
								{series.name}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{chart.x.map((x, row) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
						<tr key={row}>
							<th scope="row">{x}</th>
							{chart.series.map((series, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
								<td key={index}>{formatNumber(series.y[row])}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Table({
	panel,
}: {
	panel: Extract<ArtifactPanel, { type: "table" }>;
}) {
	return (
		<section
			className="artifact-scroll artifact-body"
			aria-label="Table, scrollable"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a wide table scrolls, so the keyboard must reach it.
			tabIndex={0}
		>
			<table className="artifact-table">
				<thead>
					<tr>
						{panel.columns.map((column, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
							<th key={index} scope="col">
								{column}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{panel.rows.map((row, r) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
						<tr key={r}>
							{row.map((cell, c) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this render.
								<td key={c} data-number={typeof cell === "number" || undefined}>
									{cellText(cell)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{panel.rows.length >= ARTIFACT_LIMITS.rows ? (
				<p className="artifact-note">
					Showing the first {ARTIFACT_LIMITS.rows} rows.
				</p>
			) : null}
		</section>
	);
}
