import type { CSSProperties } from "react";

/**
 * The ytimesy logo: the Y mark, the word "times", the Y mark, so the logo
 * reads the way the name is said, "Y times Y". Where there is room for only
 * one symbol (favicon, small icons), use the single mark instead.
 */
export function Wordmark({ size = 28 }: { size?: number }) {
	const style = { "--wm": `${size}px` } as CSSProperties;
	return (
		<span className="wordmark" style={style}>
			<img
				className="wordmark-y"
				src="/brand/mark.svg"
				width={size}
				height={size}
				alt=""
			/>
			<span className="wordmark-times">times</span>
			<img
				className="wordmark-y"
				src="/brand/mark.svg"
				width={size}
				height={size}
				alt=""
			/>
		</span>
	);
}
