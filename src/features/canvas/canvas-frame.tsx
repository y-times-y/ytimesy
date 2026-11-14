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
}: {
	html: string;
	title: string;
	className?: string;
	/** A small, inert thumbnail: loaded lazily and out of the tab order. */
	preview?: boolean;
}) {
	return (
		<iframe
			className={className}
			title={title}
			sandbox={CANVAS_SANDBOX}
			srcDoc={canvasDocument(html)}
			referrerPolicy="no-referrer"
			{...(preview
				? { loading: "lazy" as const, tabIndex: -1, "aria-hidden": true }
				: {})}
		/>
	);
}
