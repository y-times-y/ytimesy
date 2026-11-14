import {
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	type LucideIcon,
	Monitor,
	Scan,
	Smartphone,
	Tablet,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useLayoutEffect, useRef, useState } from "react";
import { type CanvasThread, canvasStandalonePage } from "#/domain/canvas";
import { CanvasFrame } from "./canvas-frame";
import type { CanvasFocus } from "./canvas-open-context";
import "./canvas.css";

/** The preview widths: the panel's own, or a device's, scaled down to fit. */
const WIDTHS = [
	{ id: "fit", label: "Fit to panel", icon: Scan, width: null },
	{ id: "desktop", label: "Desktop (1280 px)", icon: Monitor, width: 1280 },
	{ id: "tablet", label: "Tablet (768 px)", icon: Tablet, width: 768 },
	{ id: "mobile", label: "Mobile (390 px)", icon: Smartphone, width: 390 },
] as const satisfies readonly {
	id: string;
	label: string;
	icon: LucideIcon;
	width: number | null;
}[];
type PreviewWidth = (typeof WIDTHS)[number]["id"];

/** Space kept around a device frame on the stage. */
const STAGE_GUTTER = 32;

/**
 * The right panel's Canvas view: the chosen canvas (the latest one by
 * default) at the chosen revision (the latest by default), with a canvas
 * picker, a revision switcher, preview widths and Open in new tab.
 */
export function CanvasInspector({
	canvases,
	focus,
	onFocusChange,
}: {
	canvases: readonly CanvasThread[];
	focus?: CanvasFocus;
	onFocusChange: (focus: CanvasFocus) => void;
}) {
	const [width, setWidth] = useState<PreviewWidth>("fit");
	const thread =
		canvases.find((entry) => entry.title === focus?.title) ?? canvases.at(-1);
	if (!thread)
		return (
			<section className="inspector-empty" data-kind="canvas">
				<h2>No canvas yet.</h2>
				<p>
					When an agent shows a mockup, prototype, chart or diagram, it opens
					here as a live preview.
				</p>
			</section>
		);
	const latest = thread.revisions.at(-1) as CanvasThread["revisions"][number];
	const shown =
		(focus?.title === thread.title &&
			thread.revisions.find((entry) => entry.revision === focus.revision)) ||
		latest;
	const position = thread.revisions.indexOf(shown);
	const step = (offset: number) => {
		const next = thread.revisions[position + offset];
		if (!next) return;
		onFocusChange({
			title: thread.title,
			...(next === latest ? {} : { revision: next.revision }),
		});
	};
	const preview = WIDTHS.find((entry) => entry.id === width) ?? WIDTHS[0];
	return (
		<section className="canvas-inspector" aria-label="Canvas">
			<header className="canvas-inspector-bar">
				<CanvasPicker
					canvases={canvases}
					current={thread.title}
					onPick={(title) => onFocusChange({ title })}
				/>
				<fieldset className="canvas-revisions" aria-label="Revision">
					<button
						type="button"
						className="canvas-icon-button"
						aria-label="Previous revision"
						disabled={position <= 0}
						onClick={() => step(-1)}
					>
						<ChevronLeft size={14} strokeWidth={1.75} />
					</button>
					<span className="canvas-revision-label" aria-live="polite">
						rev {shown.revision}
						<span className="canvas-revision-total"> / {latest.revision}</span>
					</span>
					<button
						type="button"
						className="canvas-icon-button"
						aria-label="Next revision"
						disabled={position >= thread.revisions.length - 1}
						onClick={() => step(1)}
					>
						<ChevronRight size={14} strokeWidth={1.75} />
					</button>
				</fieldset>
				<div className="canvas-inspector-spacer" />
				<fieldset className="canvas-widths" aria-label="Preview width">
					{WIDTHS.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							aria-pressed={width === id}
							aria-label={label}
							title={label}
							className="canvas-icon-button"
							onClick={() => setWidth(id)}
						>
							<Icon size={14} strokeWidth={1.75} />
						</button>
					))}
				</fieldset>
				<button
					type="button"
					className="canvas-icon-button"
					aria-label="Open in new tab"
					title="Open in new tab"
					disabled={shown.html === null}
					onClick={() =>
						shown.html !== null && openStandalone(thread.title, shown.html)
					}
				>
					<ExternalLink size={14} strokeWidth={1.75} />
				</button>
			</header>
			{shown.html === null ? (
				<section className="inspector-empty" data-kind="canvas">
					<h2>This revision is no longer kept.</h2>
					<p>
						A chat keeps its newest canvas revisions; step to a newer one to see
						it.
					</p>
				</section>
			) : (
				<CanvasStage
					key={`${thread.title}:${shown.revision}`}
					html={shown.html}
					title={thread.title}
					deviceWidth={preview.width}
				/>
			)}
		</section>
	);
}

/** The preview, at the panel's width or a device width scaled to fit the panel. */
function CanvasStage({
	html,
	title,
	deviceWidth,
}: {
	html: string;
	title: string;
	deviceWidth: number | null;
}) {
	const stage = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<{ width: number; height: number } | null>(
		null,
	);
	useLayoutEffect(() => {
		const element = stage.current;
		if (!element) return;
		const measure = () =>
			setSize({ width: element.clientWidth, height: element.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const scale =
		deviceWidth && size
			? Math.min(1, (size.width - STAGE_GUTTER) / deviceWidth)
			: 1;
	const device = deviceWidth !== null;
	return (
		<div
			ref={stage}
			className="canvas-stage"
			data-device={device ? "true" : undefined}
		>
			<div
				className="canvas-device"
				style={
					device && size
						? {
								width: deviceWidth,
								height: (size.height - STAGE_GUTTER) / scale,
								transform: `scale(${scale})`,
							}
						: undefined
				}
			>
				<CanvasFrame html={html} title={title} className="canvas-frame" />
			</div>
		</div>
	);
}

function CanvasPicker({
	canvases,
	current,
	onPick,
}: {
	canvases: readonly CanvasThread[];
	current: string;
	onPick: (title: string) => void;
}) {
	if (canvases.length < 2)
		return (
			<span className="canvas-picker" data-single="true" title={current}>
				{current}
			</span>
		);
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button type="button" className="canvas-picker" title={current}>
					<span className="canvas-picker-label">{current}</span>
					<ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					className="recovery-menu inspector-view-menu"
					sideOffset={6}
					align="start"
				>
					{[...canvases].reverse().map((entry) => (
						<DropdownMenu.Item
							key={entry.title}
							data-selected={entry.title === current || undefined}
							onSelect={() => onPick(entry.title)}
						>
							<span className="menu-row-label">{entry.title}</span>
							<span className="canvas-picker-count">
								{entry.revisions.length > 1
									? `${entry.revisions.length} revs`
									: ""}
							</span>
							<span className="menu-row-check">
								{entry.title === current ? (
									<Check size={14} strokeWidth={1.5} aria-hidden="true" />
								) : null}
							</span>
						</DropdownMenu.Item>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

/**
 * Shows the canvas alone in a new tab: a scriptless page holding the same
 * sandboxed frame (canvasStandalonePage), from a short-lived blob URL.
 */
function openStandalone(title: string, html: string) {
	const url = URL.createObjectURL(
		new Blob([canvasStandalonePage(title, html)], { type: "text/html" }),
	);
	window.open(url, "_blank", "noopener,noreferrer");
	// The new tab has read it by then.
	window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
