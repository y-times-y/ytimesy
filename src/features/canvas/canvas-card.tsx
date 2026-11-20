import { AppWindow, ArrowUpRight } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { CanvasItem } from "#/domain/session-item";
import { useWholeItem } from "../sessions/whole-item";
import { CanvasFrame } from "./canvas-frame";
import { useCanvasOpener } from "./canvas-open-context";
import "./canvas.css";

/**
 * A canvas the agent showed, in the transcript: a live thumbnail, its title
 * and Open, which shows it in the right panel. No revision number here: the
 * panel has the revision switcher.
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
	// A page read leaves a canvas's html out (it can be 500 KB): the card reads
	// it whole, once, when it scrolls into view, as the panel does when opened.
	const thumb = useRef<HTMLDivElement>(null);
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		const element = thumb.current;
		if (seen || !element) return;
		if (typeof IntersectionObserver === "undefined") {
			setSeen(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setSeen(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "200px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [seen]);
	const whole = useWholeItem(item, seen);
	const html = whole.html;
	// Left out by the page and still being read: not the same as no longer kept.
	const reading = html === null && whole.htmlOmitted === true;
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
			data-kept={html === null && !reading ? "false" : undefined}
			data-owner-thread={item.ownerThreadId}
			aria-label={`Canvas ${item.title}`}
		>
			<div className="canvas-card-thumb" ref={thumb}>
				{html === null ? (
					<AppWindow size={18} strokeWidth={1.5} aria-hidden="true" />
				) : (
					<CanvasFrame
						html={html}
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
				</span>
				<strong className="canvas-card-title" title={item.title}>
					{item.title}
				</strong>
				<span className="canvas-card-meta">
					{html === null && !reading
						? "This older revision is no longer kept."
						: item.path
							? item.path
							: item.ownerThreadId
								? "From a thread · HTML preview"
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
