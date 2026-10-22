import { inlineMarkdownSegments } from "#/domain/markdown-text";

/** One line with its inline code and bold rendered; nothing else parsed. */
export function InlineMarkdown({ text }: { text: string }) {
	return inlineMarkdownSegments(text).map((segment, index) =>
		segment.kind === "code" ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed line
			<code key={index}>{segment.text}</code>
		) : segment.kind === "strong" ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed line
			<strong key={index}>{segment.text}</strong>
		) : (
			segment.text
		),
	);
}
