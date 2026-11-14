import { AppWindow, ArrowUpRight } from "lucide-react";
import { memo } from "react";
import type { CanvasItem } from "#/domain/session-item";
import { CanvasFrame } from "./canvas-frame";
import { useCanvasOpener } from "./canvas-open-context";
import "./canvas.css";

/**
 * A canvas the agent showed, in the transcript: a live thumbnail, its title
 * and revision, and Open, which shows it in the right panel.
 */
export function CanvasCard({
	item,
	latest,
}: {
	item: CanvasItem;
	/** The canvas has no newer revision: opening it follows later ones. */
	latest: boolean;
}) {
	const open = useCanvasOpener();
	const show = open
		? () =>
				open({
					title: item.title,
					...(latest ? {} : { revision: item.revision }),
				})
		: undefined;
	return (
		<article
			className="canvas-card"
			data-kept={item.html === null ? "false" : undefined}
			aria-label={`Canvas ${item.title}, revision ${item.revision}`}
		>
			<div className="canvas-card-thumb">
				{item.html === null ? (
					<AppWindow size={18} strokeWidth={1.5} aria-hidden="true" />
				) : (
					<CanvasFrame
						html={item.html}
						title={`${item.title} thumbnail`}
						className="canvas-card-thumb-frame"
						preview
					/>
				)}
				{show ? (
					<button
						type="button"
						className="canvas-card-thumb-hit"
						aria-hidden="true"
						tabIndex={-1}
						onClick={show}
					/>
				) : null}
			</div>
			<div className="canvas-card-body">
				<span className="canvas-card-kicker">
					<AppWindow size={13} strokeWidth={1.75} aria-hidden="true" />
					Canvas
					<span className="canvas-card-dot" aria-hidden="true">
						·
					</span>
					rev {item.revision}
				</span>
				<strong className="canvas-card-title" title={item.title}>
					{item.title}
				</strong>
				<span className="canvas-card-meta">
					{item.html === null
						? "This older revision is no longer kept."
						: item.path
							? item.path
							: "HTML preview"}
				</span>
			</div>
			{show ? (
				<button type="button" className="canvas-card-open" onClick={show}>
					Open
					<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
				</button>
			) : null}
		</article>
	);
}

export const MemoCanvasCard = memo(CanvasCard);
