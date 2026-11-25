import type { Ref } from "react";
import { CANVAS_SANDBOX, canvasDocument } from "#/domain/canvas";

/**
 * One canvas document, rendered in a sandboxed frame: its scripts run in an
 * opaque origin with the offline policy at the top (CANVAS_CSP), so it can
 * never reach the app's cookies, storage, API or page.
 */
export function CanvasFrame({
	html,
	title,
	className,
	preview,
	frameRef,
	onLoad,
	fixed,
}: {
	html: string;
	title: string;
	className?: string;
	frameRef?: Ref<HTMLIFrameElement>;
	onLoad?: () => void;
	/** A small, inert thumbnail: loaded lazily and out of the tab order. */
	preview?: boolean;
	/** Sized to its document by the viewer: no scrollbars of its own. */
	fixed?: boolean;
}) {
	return (
		<iframe
			ref={frameRef}
			onLoad={onLoad}
			className={className}
			title={title}
			sandbox={CANVAS_SANDBOX}
			srcDoc={canvasDocument(html)}
			referrerPolicy="no-referrer"
			{...(fixed ? { scrolling: "no" } : {})}
			{...(preview
				? { loading: "lazy" as const, tabIndex: -1, "aria-hidden": true }
				: {})}
		/>
	);
}
