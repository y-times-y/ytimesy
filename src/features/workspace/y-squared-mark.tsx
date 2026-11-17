import { type CSSProperties, useId } from "react";

/** The sizes Y²'s mark is drawn at: sidebar, chat header, overview, empty state. */
export type YSquaredMarkSize = 16 | 20 | 28 | 40;

/**
 * The brand Y mark's silhouette, path for path from public/brand/mark.svg
 * (a test keeps them equal): Y² draws the logo's own border.
 */
export const BRAND_MARK_SILHOUETTE =
	"M4 8h6v4l6 6 6-6V2h6v13l-9 9v6h-6v-6l-9-9V8Z";

/** Border width in the mark's 32-unit grid. */
const BORDER = 1.6;

/**
 * Y²'s mark: the logo as its border only (the brand silhouette, hollow),
 * with a "2" on top. While `live` (threads are working) a light runs around
 * the border; otherwise the border rests. Decorative: a name or label always
 * stands beside it.
 */
export function YSquaredMark({
	size = 16,
	live = false,
	className,
}: {
	size?: YSquaredMarkSize;
	live?: boolean;
	className?: string;
}) {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const light = `y2m-light-${id}`;
	const style = { "--y2m": `${size}px` } as CSSProperties;
	const border = {
		d: BRAND_MARK_SILHOUETTE,
		fill: "none",
		strokeWidth: BORDER,
		strokeLinejoin: "round",
	} as const;
	return (
		<span
			className={className ? `y2-mark ${className}` : "y2-mark"}
			style={style}
			data-live={live ? "true" : undefined}
			aria-hidden="true"
		>
			<svg
				className="y2-mark-glyph"
				viewBox="0 -6 40 38"
				fill="none"
				aria-hidden="true"
			>
				<defs>
					<linearGradient id={light} x1="0" y1="0" x2="1" y2="1">
						<stop offset="0" stopColor="#93c5fd" />
						<stop offset="1" stopColor="#a78bfa" />
					</linearGradient>
				</defs>
				<path {...border} className="y2-mark-border" stroke="#F2F2F0" />
				{live ? (
					<path
						{...border}
						className="y2-mark-light"
						stroke={`url(#${light})`}
						strokeWidth={BORDER + 0.3}
						strokeLinecap="round"
						pathLength={100}
						strokeDasharray="22 78"
					/>
				) : null}
				<text className="y2-mark-exponent" x="30" y="2">
					2
				</text>
			</svg>
		</span>
	);
}
