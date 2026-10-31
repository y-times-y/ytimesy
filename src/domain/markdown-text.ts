/**
 * Small Markdown text rules for places that show a line, not a document:
 * a helper's finish card and a reply still streaming.
 */

/**
 * A streaming reply without an emphasis or code marker it has just begun
 * ("Done. **"): the renderer can close "**word" but shows a bare "**" as
 * text until the word arrives.
 */
export function withoutDanglingMarker(text: string) {
	return text.replace(/(^|\s)(?:\*{1,3}|_{1,3}|`{1,3}|~~)\s*$/, "$1");
}

/**
 * A reply without its `<pull-request>` description, which is published to
 * GitHub rather than shown in the chat. A block still streaming in (no close
 * tag yet) is hidden from its open tag on.
 */
export function withoutPullRequestBlock(text: string) {
	return text
		.replace(/<pull-request>[\s\S]*?(?:<\/pull-request>|$)/gi, "")
		.trimEnd();
}

/** A line without its list, quote or heading prefix. */
function plainLine(line: string) {
	return line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)*/, "").trim();
}

/**
 * A report's summary line, Markdown kept: its first line of text (past
 * headings), and when that line only leads in ("…contains:"), the lines
 * after it, joined with "; ", up to `max` characters.
 */
export function reportSummaryLine(text: string | null | undefined, max = 240) {
	const lines = (text ?? "")
		.split("\n")
		.filter((line) => line.trim() && !/^\s*(```|~~~)/.test(line));
	const headings = lines.filter((line) => /^\s*#{1,6}\s/.test(line));
	const body =
		headings.length < lines.length
			? lines.filter((line) => !/^\s*#{1,6}\s/.test(line))
			: lines;
	const first = plainLine(body[0] ?? "");
	let summary = first;
	if (first.endsWith(":")) {
		const rest: string[] = [];
		for (const line of body.slice(1)) {
			const next = plainLine(line);
			if (!next) continue;
			if (`${first} ${[...rest, next].join("; ")}`.length > max && rest.length)
				break;
			rest.push(next);
		}
		if (rest.length) summary = `${first} ${rest.join("; ")}`;
	}
	return summary.length > max
		? `${summary.slice(0, max - 1).trimEnd()}…`
		: summary;
}

export type InlineSegment = {
	readonly kind: "text" | "code" | "strong";
	readonly text: string;
};

/**
 * One line's inline code and bold as segments; unmatched markers stay as
 * text, except a trailing one a cut left open, which is dropped.
 */
export function inlineMarkdownSegments(line: string): InlineSegment[] {
	const segments: InlineSegment[] = [];
	const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__/g;
	let at = 0;
	for (const match of line.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > at)
			segments.push({ kind: "text", text: line.slice(at, index) });
		if (match[1] !== undefined) segments.push({ kind: "code", text: match[1] });
		else segments.push({ kind: "strong", text: match[2] ?? match[3] ?? "" });
		at = index + match[0].length;
	}
	const tail = line.slice(at).replace(/(?:`|\*\*|__)(?=[^`*_]*…?$)/, "");
	if (tail) segments.push({ kind: "text", text: tail });
	return segments;
}
