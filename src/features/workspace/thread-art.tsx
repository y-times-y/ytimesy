import type { CSSProperties } from "react";
import { threadArt } from "#/domain/thread-art";

/**
 * A thread's picture (src/domain/thread-art.ts): a small rounded square.
 * Decorative: the thread's name is always next to it, so it has no alt text.
 */
export function ThreadArt({ id, size }: { id: string; size: number }) {
	const art = threadArt(id);
	return (
		<img
			className="thread-art"
			src={art.src}
			alt=""
			width={size}
			height={size}
			loading="lazy"
			decoding="async"
			draggable={false}
			data-palette={art.palette}
			style={
				{
					"--thread-art-size": `${size}px`,
					backgroundColor: art.base,
				} as CSSProperties
			}
		/>
	);
}
