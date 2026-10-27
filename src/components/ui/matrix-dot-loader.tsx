import { cn } from "cn";
import type { ComponentProps, CSSProperties } from "react";

/** Each pixel's distance from the top-left corner (row-major): the wave's phase. */
const DIAGONALS = [0, 1, 2, 1, 2, 3, 2, 3, 4];

export function MatrixDotLoader({
	className,
	...props
}: ComponentProps<"span">) {
	return (
		<span className={cn("t-matrix", className)} aria-hidden="true" {...props}>
			{DIAGONALS.map((diagonal, index) => (
				<i
					// biome-ignore lint/suspicious/noArrayIndexKey: nine fixed pixels
					key={index}
					style={{ "--t-matrix-diag": diagonal } as CSSProperties}
				/>
			))}
		</span>
	);
}
