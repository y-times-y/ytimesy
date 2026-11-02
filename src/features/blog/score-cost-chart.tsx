import {
	type KeyboardEvent,
	type MouseEvent,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	SCORE_COST_POINTS,
	type ScoreCostPoint,
} from "#/features/landing/landing-facts";
import "./score-cost-chart.css";

/**
 * Terminal-Bench 4.0 score against cost per attempt (cheaper to the right),
 * for the launch post and the front page. Two drawings of the same chart:
 * a wide one, and a narrow one whose text stays readable on a phone. The
 * wrapper's width picks one in CSS (a container query), so the first paint
 * is already the right one. Colours come from --scc-* variables set by the
 * page around it.
 */

type Label = {
	/** From the point to the label's anchor, in chart units. */
	dx: number;
	/** From the point to the first line's baseline. */
	dy: number;
	anchor: "start" | "middle" | "end";
	lineGap: number;
};

type Layout = {
	name: "wide" | "narrow";
	width: number;
	height: number;
	left: number;
	right: number;
	top: number;
	bottom: number;
	/** Cost axis, most expensive at the left. */
	costFrom: number;
	costTo: number;
	costTicks: number[];
	scoreFrom: number;
	scoreTo: number;
	ours: { radius: number; logoScale: number };
	others: { radius: number };
	labels: Record<string, Label>;
	scoreTitle: boolean;
	tag: { height: number; scoreWidth: number; costWidth: number; text: number };
};

const WIDE: Layout = {
	name: "wide",
	width: 760,
	height: 420,
	left: 76,
	right: 40,
	top: 30,
	bottom: 74,
	costFrom: 11,
	costTo: 6,
	costTicks: [11, 10, 9, 8, 7, 6],
	scoreFrom: 56,
	scoreTo: 60,
	ours: { radius: 17, logoScale: 0.7 },
	others: { radius: 5.5 },
	labels: {
		"ytimesy-xhigh": { dx: -26, dy: -40, anchor: "end", lineGap: 19 },
		// Below its point: the 58.5% line runs just above it.
		"Codex-max": { dx: 14, dy: 24, anchor: "start", lineGap: 18 },
		"Codex-xhigh": { dx: 14, dy: -8, anchor: "start", lineGap: 18 },
	},
	scoreTitle: true,
	tag: { height: 22, scoreWidth: 50, costWidth: 54, text: 16 },
};

const NARROW: Layout = {
	name: "narrow",
	width: 360,
	height: 380,
	left: 46,
	right: 14,
	top: 18,
	bottom: 58,
	// Down to $5.50, so Codex xhigh's label fits right of our cost line.
	costFrom: 10.5,
	costTo: 5.5,
	costTicks: [10, 9, 8, 7, 6],
	scoreFrom: 56,
	scoreTo: 60,
	ours: { radius: 13, logoScale: 0.54 },
	others: { radius: 4.5 },
	labels: {
		// Centred above its point, clear of the score ticks at the left.
		"ytimesy-xhigh": { dx: 0, dy: -44, anchor: "middle", lineGap: 16 },
		"Codex-max": { dx: 12, dy: 24, anchor: "start", lineGap: 16 },
		// Right-aligned to the plot's edge, below its point and clear of our cost line.
		"Codex-xhigh": { dx: 0, dy: 24, anchor: "end", lineGap: 16 },
	},
	scoreTitle: false,
	tag: { height: 18, scoreWidth: 44, costWidth: 44, text: 13 },
};

const pointKey = (point: ScoreCostPoint) => `${point.agent}-${point.effort}`;
const money = (cost: number) => `$${cost.toFixed(2)}`;
const percent = (score: number) => `${score.toFixed(1)}%`;

function scales(layout: Layout) {
	const plotWidth = layout.width - layout.left - layout.right;
	const plotHeight = layout.height - layout.top - layout.bottom;
	return {
		x: (cost: number) =>
			layout.left +
			((layout.costFrom - cost) / (layout.costFrom - layout.costTo)) *
				plotWidth,
		y: (score: number) =>
			layout.top +
			(1 - (score - layout.scoreFrom) / (layout.scoreTo - layout.scoreFrom)) *
				plotHeight,
	};
}

/** The single Y mark, coloured by --mark-* so it shows on light and dark. */
function Mark({ x, y, scale }: { x: number; y: number; scale: number }) {
	return (
		<g transform={`translate(${x} ${y}) scale(${scale})`}>
			<path
				d="M4 8h6v4l6 6 6-6V2h6v13l-9 9v6h-6v-6l-9-9V8Z"
				style={{ fill: "var(--mark-0, #242424)" }}
			/>
			<path
				d="m4 15 12 7v8h-3v-6l-9-9Z"
				style={{ fill: "var(--mark-1, #757575)" }}
			/>
			<path
				d="m16 22 12-7-9 9v6h-3v-8Z"
				style={{ fill: "var(--mark-2, #484848)" }}
			/>
			<path
				d="m4 8 6 4 6 6v4L4 15V8Z"
				style={{ fill: "var(--mark-3, #5B5B5B)" }}
			/>
			<path
				d="m22 12 6-10v13l-12 7v-4l6-6Z"
				style={{ fill: "var(--mark-4, #111111)" }}
			/>
		</g>
	);
}

function Drawing({
	layout,
	active,
	onActive,
}: {
	layout: Layout;
	active: number | null;
	onActive: (index: number | null, svg: SVGSVGElement | null) => void;
}) {
	const { x, y } = scales(layout);
	const plotRight = layout.width - layout.right;
	const plotBottom = layout.height - layout.bottom;
	const points = SCORE_COST_POINTS.map((point) => ({
		...point,
		px: x(point.cost),
		py: y(point.score),
	}));
	const ours = points.find((point) => point.ours);
	const scoreTicks: number[] = [];
	for (let s = layout.scoreFrom; s <= layout.scoreTo; s++) scoreTicks.push(s);

	const nearest = (event: MouseEvent<SVGSVGElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const mx = ((event.clientX - rect.left) / rect.width) * layout.width;
		const my = ((event.clientY - rect.top) / rect.height) * layout.height;
		let best: number | null = null;
		let bestDistance = 44;
		points.forEach((point, index) => {
			const distance = Math.hypot(point.px - mx, point.py - my);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = index;
			}
		});
		return best;
	};
	const step = (event: KeyboardEvent<SVGSVGElement>) => {
		const count = points.length;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			event.preventDefault();
			onActive(active === null ? 0 : (active + 1) % count, event.currentTarget);
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			event.preventDefault();
			onActive(
				active === null ? count - 1 : (active - 1 + count) % count,
				event.currentTarget,
			);
		} else if (event.key === "Enter" && active !== null) {
			window.open(points[active].href, "_blank", "noopener");
		} else if (event.key === "Escape") onActive(null, null);
	};
	const activePoint = active === null ? null : points[active];

	return (
		<svg
			className={`scc-svg scc-${layout.name}`}
			viewBox={`0 0 ${layout.width} ${layout.height}`}
			role="img"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the chart steps through its points with the arrow keys.
			tabIndex={0}
			aria-label={`Score against cost per attempt, GPT-6 Astra. ${points
				.map(
					(point) =>
						`${point.agent} ${point.effort} ${percent(point.score)} at ${money(point.cost)}`,
				)
				.join("; ")}. Use the arrow keys to step through the points.`}
			data-pointer={activePoint ? "true" : undefined}
			onMouseMove={(event) => {
				const index = nearest(event);
				if (index !== active) onActive(index, event.currentTarget);
			}}
			onMouseLeave={() => onActive(null, null)}
			onClick={() => {
				if (activePoint) window.open(activePoint.href, "_blank", "noopener");
			}}
			onKeyDown={step}
			onBlur={() => onActive(null, null)}
		>
			{scoreTicks.map((score) => (
				<g key={score}>
					{score > layout.scoreFrom ? (
						<line
							x1={layout.left}
							x2={plotRight}
							y1={y(score)}
							y2={y(score)}
							className="scc-grid"
						/>
					) : null}
					<text
						x={layout.left - (layout.name === "wide" ? 12 : 8)}
						y={y(score) + 5}
						className="scc-tick"
						textAnchor="end"
					>
						{score}%
					</text>
				</g>
			))}
			<line
				x1={layout.left}
				x2={plotRight}
				y1={plotBottom}
				y2={plotBottom}
				className="scc-axis"
			/>
			{layout.costTicks.map((cost) => (
				<g key={cost}>
					<line
						x1={x(cost)}
						x2={x(cost)}
						y1={plotBottom}
						y2={plotBottom + 5}
						className="scc-axis"
					/>
					<text
						x={x(cost)}
						y={plotBottom + 26}
						className="scc-tick"
						textAnchor="middle"
					>
						${cost}
					</text>
				</g>
			))}
			<text
				x={(layout.left + plotRight) / 2}
				y={layout.height - 10}
				className="scc-title"
				textAnchor="middle"
			>
				Cost per attempt (USD) · Cheaper →
			</text>
			{layout.scoreTitle ? (
				<text
					transform={`translate(22 ${(layout.top + plotBottom) / 2}) rotate(-90)`}
					className="scc-title"
					textAnchor="middle"
				>
					Score
				</text>
			) : null}

			{ours ? (
				<g>
					<line
						x1={layout.left}
						x2={ours.px - layout.ours.radius - 1}
						y1={ours.py}
						y2={ours.py}
						className="scc-guide"
					/>
					<rect
						x={layout.left + 6}
						y={ours.py - layout.tag.height / 2}
						width={layout.tag.scoreWidth}
						height={layout.tag.height}
						rx={6}
						className="scc-tag-bg"
					/>
					<text
						x={layout.left + 6 + layout.tag.scoreWidth / 2}
						y={ours.py + layout.tag.text / 2 - 3}
						className="scc-tag"
						textAnchor="middle"
					>
						{percent(ours.score)}
					</text>
					{/* The dashed line down to our cost, at every width. */}
					<line
						x1={ours.px}
						x2={ours.px}
						y1={ours.py + layout.ours.radius + 1}
						y2={plotBottom}
						className="scc-guide"
					/>
					<rect
						x={ours.px - layout.tag.costWidth / 2}
						y={plotBottom - 6 - layout.tag.height}
						width={layout.tag.costWidth}
						height={layout.tag.height}
						rx={6}
						className="scc-tag-bg"
					/>
					<text
						x={ours.px}
						y={plotBottom - 6 - layout.tag.height / 2 + layout.tag.text / 2 - 3}
						className="scc-tag"
						textAnchor="middle"
					>
						{money(ours.cost)}
					</text>
				</g>
			) : null}

			{points.map((point) => {
				const label = layout.labels[pointKey(point)];
				const lx =
					label.anchor === "end" && !point.ours && label.dx === 0
						? plotRight
						: point.px + label.dx;
				const ly = point.py + label.dy;
				if (point.ours) {
					const size = 32 * layout.ours.logoScale;
					return (
						<g key={pointKey(point)}>
							<circle
								cx={point.px}
								cy={point.py}
								r={layout.ours.radius}
								className="scc-point-ours"
							/>
							<Mark
								x={point.px - size / 2}
								y={point.py - size / 2}
								scale={layout.ours.logoScale}
							/>
							<text
								x={lx}
								y={ly}
								className="scc-name scc-name-ours"
								textAnchor={label.anchor}
							>
								ytimesy{" "}
								<tspan className="scc-effort">· GPT-6 Astra xhigh</tspan>
							</text>
							<text
								x={lx}
								y={ly + label.lineGap}
								className="scc-sub"
								textAnchor={label.anchor}
							>
								{percent(point.score)} · {money(point.cost)}
							</text>
						</g>
					);
				}
				return (
					<g key={pointKey(point)}>
						<circle
							cx={point.px}
							cy={point.py}
							r={layout.others.radius}
							className="scc-point"
						/>
						<text x={lx} y={ly} className="scc-name" textAnchor={label.anchor}>
							{point.agent}
						</text>
						<text
							x={lx}
							y={ly + label.lineGap}
							className="scc-sub"
							textAnchor={label.anchor}
						>
							GPT-6 Astra {point.effort}
						</text>
						<text
							x={lx}
							y={ly + label.lineGap * 2}
							className="scc-sub"
							textAnchor={label.anchor}
						>
							{percent(point.score)} · {money(point.cost)}
						</text>
					</g>
				);
			})}
			{activePoint ? (
				<circle
					cx={activePoint.px}
					cy={activePoint.py}
					r={activePoint.ours ? layout.ours.radius + 6 : 11}
					className="scc-ring"
				/>
			) : null}
		</svg>
	);
}

type Tip = { index: number; left: number; top: number; below: boolean };

export function ScoreCostChart() {
	const wrap = useRef<HTMLDivElement>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const [tip, setTip] = useState<Tip | null>(null);

	const onActive = (index: number | null, svg: SVGSVGElement | null) => {
		if (index === null || !svg || !wrap.current) {
			setTip(null);
			return;
		}
		const layout = svg.classList.contains("scc-narrow") ? NARROW : WIDE;
		const { x, y } = scales(layout);
		const point = SCORE_COST_POINTS[index];
		const rect = svg.getBoundingClientRect();
		const wrapRect = wrap.current.getBoundingClientRect();
		const left =
			rect.left - wrapRect.left + (x(point.cost) / layout.width) * rect.width;
		const top =
			rect.top - wrapRect.top + (y(point.score) / layout.height) * rect.height;
		setTip({ index, left, top, below: top < 130 });
	};
	// Keep the card inside the chart once its width is known.
	useLayoutEffect(() => {
		const card = tipRef.current;
		const box = wrap.current;
		if (!tip || !card || !box) return;
		const half = card.offsetWidth / 2 + 4;
		card.style.left = `${Math.min(Math.max(tip.left, half), box.clientWidth - half)}px`;
	}, [tip]);
	const point = tip ? SCORE_COST_POINTS[tip.index] : null;

	return (
		<div className="scc" ref={wrap}>
			<Drawing layout={WIDE} active={tip?.index ?? null} onActive={onActive} />
			<Drawing
				layout={NARROW}
				active={tip?.index ?? null}
				onActive={onActive}
			/>
			{tip && point ? (
				<div
					ref={tipRef}
					className="scc-tip"
					data-below={tip.below || undefined}
					style={{ left: tip.left, top: tip.top }}
					role="status"
				>
					<div className="scc-tip-name">
						{point.agent} <span>· GPT-6 Astra · {point.effort}</span>
					</div>
					<div className="scc-tip-row">
						<span>Score</span>
						<b>{percent(point.score)}</b>
					</div>
					<div className="scc-tip-row">
						<span>Cost per attempt</span>
						<b>{money(point.cost)}</b>
					</div>
					<div className="scc-tip-row">
						<span>Tasks solved at least once</span>
						<b>{point.solved} of 66</b>
					</div>
					<div className="scc-tip-foot">Click for the Harbor job</div>
				</div>
			) : null}
		</div>
	);
}
