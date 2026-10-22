import { Fragment, type ReactNode } from "react";
import { inlineMarkdownSegments } from "#/domain/markdown-text";

/** One line with its inline code and bold rendered; nothing else parsed. */
export function InlineMarkdown({
	text,
	renderText,
}: {
	text: string;
	/** Renders plain-text segments, e.g. to chip agent names. */
	renderText?: (text: string) => ReactNode;
}) {
	return inlineMarkdownSegments(text).map((segment, index) =>
		segment.kind === "code" ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed line
			<code key={index}>{segment.text}</code>
		) : segment.kind === "strong" ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed line
			<strong key={index}>{segment.text}</strong>
		) : renderText ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed line
			<Fragment key={index}>{renderText(segment.text)}</Fragment>
		) : (
			segment.text
		),
	);
}
