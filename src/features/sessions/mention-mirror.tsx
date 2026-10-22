import { forwardRef } from "react";
import type { MentionAgent, MentionSegment } from "#/domain/agent-mentions";
import { AgentIcon } from "./agent-icon";

/**
 * Drawn behind the composer's textarea while its draft mentions agents: the
 * same text in the same box, with each mention's "@" replaced by the agent's
 * icon. The textarea keeps the caret, selection, IME, undo and paste; its
 * glyphs go transparent (task-input.css) so this layer shows instead.
 * syncMirror keeps the two boxes identical.
 */
export const MentionMirror = forwardRef<
	HTMLDivElement,
	{
		segments: readonly MentionSegment[];
		agents: ReadonlyMap<string, MentionAgent>;
	}
>(function MentionMirror({ segments, agents }, ref) {
	return (
		<div ref={ref} className="composer-mirror" aria-hidden="true">
			{segments.map((segment, index) => {
				const agent =
					segment.kind === "mention"
						? agents.get(segment.name.toLowerCase())
						: undefined;
				if (segment.kind === "text" || !agent)
					return segment.kind === "text" ? (
						segment.text
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: a draft's segments keep their order
						<span key={index}>@{segment.name}</span>
					);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: a draft's segments keep their order
					<span key={index} className="composer-mention">
						<span className="composer-mention-at">
							@
							<AgentIcon icon={agent.icon} color={agent.color} size={12} />
						</span>
						{segment.name}
					</span>
				);
			})}
			{/* A last empty line still takes its height, as in the textarea. */}
			{"​"}
		</div>
	);
});

const COPIED = [
	"boxSizing",
	"fontFamily",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"fontStretch",
	"fontVariant",
	"fontFeatureSettings",
	"fontKerning",
	"letterSpacing",
	"wordSpacing",
	"lineHeight",
	"textTransform",
	"textIndent",
	"textAlign",
	"textRendering",
	"tabSize",
	"whiteSpace",
	"wordBreak",
	"overflowWrap",
	"paddingTop",
	"paddingBottom",
	"paddingLeft",
	"borderTopWidth",
	"borderRightWidth",
	"borderBottomWidth",
	"borderLeftWidth",
	"color",
] as const;

/** Puts the mirror exactly over the textarea's box, wrapping and scroll. */
export function syncMirror(input: HTMLTextAreaElement, mirror: HTMLElement) {
	const style = getComputedStyle(input);
	for (const property of COPIED) mirror.style[property] = style[property];
	// The textarea's scrollbar narrows its text: the mirror wraps the same.
	const border =
		(Number.parseFloat(style.borderLeftWidth) || 0) +
		(Number.parseFloat(style.borderRightWidth) || 0);
	const scrollbar = Math.max(0, input.offsetWidth - input.clientWidth - border);
	mirror.style.paddingRight = `${(Number.parseFloat(style.paddingRight) || 0) + scrollbar}px`;
	mirror.style.top = `${input.offsetTop}px`;
	mirror.style.left = `${input.offsetLeft}px`;
	mirror.style.width = `${input.offsetWidth}px`;
	mirror.style.height = `${input.offsetHeight}px`;
	mirror.scrollTop = input.scrollTop;
	mirror.scrollLeft = input.scrollLeft;
}
