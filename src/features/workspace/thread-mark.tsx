import type { CSSProperties } from "react";
import { BRAND_MARK_SILHOUETTE } from "./y-squared-mark";

/**
 * A thread's Y: the brand mark as its border only, like the super agent's
 * (YSquaredMark) but without the "2", in the colour the row gives it
 * (--thread-color, from src/domain/thread-color.ts). Decorative: the
 * thread's title is always beside it.
 */
export function ThreadMark({ size = 16 }: { size?: number }) {
	return (
		<span
			className="thread-mark"
			style={{ "--thread-mark": `${size}px` } as CSSProperties}
			aria-hidden="true"
		>
			<svg
				className="thread-mark-glyph"
				viewBox="2 0 28 32"
				fill="none"
				aria-hidden="true"
			>
				<path
					d={BRAND_MARK_SILHOUETTE}
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					strokeLinejoin="round"
				/>
			</svg>
		</span>
	);
}
