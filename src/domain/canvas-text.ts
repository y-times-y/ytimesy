/**
 * What a canvas says, as text, for Y² (the `thread` tool's short description
 * and `read_canvas`'s outline). A canvas is a self-contained HTML document
 * that can be hundreds of KB (inline scripts, styles, base64 images); the
 * model reads only its visible content: headings, paragraphs, lists, tables
 * flattened, image alt text and a placeholder for inline svg. Nothing here
 * needs a DOM: it runs in the Worker and the browser alike.
 */

/** Longest short description of a canvas, in characters. */
export const CANVAS_DESCRIPTION_LIMIT = 300;
/** Most characters of outline one `read_canvas` call returns. */
export const CANVAS_READ_PAGE = 12_000;

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	middot: "·",
	copy: "©",
	times: "×",
	rarr: "→",
	larr: "←",
};

function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
		const name = String(body);
		if (name[0] === "#") {
			const code =
				name[1] === "x" || name[1] === "X"
					? Number.parseInt(name.slice(2), 16)
					: Number.parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000
				? String.fromCodePoint(code)
				: "";
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

const flat = (value: string) =>
	decodeEntities(value).replace(/\s+/g, " ").trim();

function attribute(tag: string, name: string): string {
	const match = new RegExp(
		`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
		"i",
	).exec(tag);
	return flat(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

/** A file name from an image's src; never a data: URI. */
function sourceName(src: string): string {
	if (!src || /^(?:data|blob):/i.test(src)) return "";
	const path = src.split(/[?#]/)[0] ?? "";
	return path.split("/").filter(Boolean).at(-1)?.slice(0, 60) ?? "";
}

/** Whether the document has pictures: <img>, <picture>, or an inline image data: URI. */
export function canvasHasImages(html: string): boolean {
	return /<img\b|<picture\b|data:image\//i.test(html);
}

/** A document's size in KB (from its length in characters), one decimal. */
export function canvasSizeKb(sizeChars: number): number {
	return Math.round((sizeChars / 1024) * 10) / 10;
}

/** The document's <title>, if it has one. */
export function canvasDocumentTitle(html: string): string {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return match ? flat(match[1] ?? "").slice(0, 120) : "";
}

/**
 * The document as a readable outline: headings (# …), paragraphs, list items
 * (- …), table rows (cells joined by " | "), `[image: alt]` and
 * `[svg: title]` placeholders. Scripts, styles, comments, head metadata and
 * every data: URI are dropped.
 */
export function canvasOutline(html: string): string {
	let source = html
		.replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
		.replace(
			/<(script|style|template|noscript|object|embed)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
			" ",
		)
		.replace(/<head\b[\s\S]*?(?:<\/head\s*>|$)/gi, " ");
	// Inline svg: its title (or label), never its paths.
	source = source.replace(
		/<svg\b([^>]*)>([\s\S]*?)(?:<\/svg\s*>|$)/gi,
		(_whole, attrs: string, inner: string) => {
			const title =
				/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(inner)?.[1] ??
				attribute(` ${attrs}`, "aria-label");
			const named = flat(title ?? "").slice(0, 80);
			return named ? ` [svg: ${named}] ` : " [svg] ";
		},
	);
	// Pictures: alt text first, else the file's name.
	source = source.replace(/<img\b[^>]*>/gi, (tag) => {
		const alt = attribute(tag, "alt").slice(0, 120);
		const named = alt || sourceName(attribute(tag, "src"));
		return named ? ` [image: ${named}] ` : " [image] ";
	});
	source = source
		.replace(
			/<h([1-6])\b[^>]*>/gi,
			(_w, level: string) => `\n${"#".repeat(Number(level))} `,
		)
		.replace(/<\/h[1-6]\s*>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<(td|th)\b[^>]*>/gi, " | ")
		.replace(/<\/tr\s*>/gi, "\n")
		.replace(
			/<\/?(?:p|div|section|article|header|footer|main|nav|aside|ul|ol|table|thead|tbody|tfoot|tr|br|hr|form|figure|figcaption|blockquote|pre|details|summary|dl|dt|dd|button|label|fieldset)\b[^>]*>/gi,
			"\n",
		)
		.replace(/<[^>]*>/g, " ");
	const lines = decodeEntities(source)
		// A stray data: URI in text never reaches the model.
		.replace(/data:[^\s"')]{40,}/gi, "[data]")
		.split("\n")
		.map((line) =>
			line
				.replace(/\s+/g, " ")
				.replace(/^\s*\|\s*/, "")
				.replace(/(?:\s*\|\s*)+$/, "")
				.replace(/\s*\|(?:\s*\|)+\s*/g, " | ")
				.trim(),
		)
		.filter((line) => line && line !== "-" && line !== "#");
	// Collapse a line repeated straight after itself.
	return lines.filter((line, index) => line !== lines[index - 1]).join("\n");
}

/** A short faithful description: title, headings, then the first visible text. */
export function canvasDescription(
	html: string,
	limit: number = CANVAS_DESCRIPTION_LIMIT,
): string {
	const outline = canvasOutline(html).split("\n");
	const title = canvasDocumentTitle(html);
	const headings = outline
		.filter((line) => line.startsWith("#"))
		.map((line) => line.replace(/^#+\s*/, ""));
	const rest = outline
		.filter((line) => !line.startsWith("#"))
		.map((line) => line.replace(/^-\s+/, ""));
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const part of [title, ...headings, ...rest]) {
		const key = part.toLowerCase();
		if (!part || seen.has(key)) continue;
		seen.add(key);
		parts.push(part);
		if (parts.join(" · ").length > limit) break;
	}
	const text = parts.join(" · ");
	return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

export type CanvasPage = {
	/** The outline text of this page. */
	readonly text: string;
	/** This page's number (from 1) and how many there are. */
	readonly part: number;
	readonly parts: number;
	/** The whole outline's length in characters. */
	readonly outlineChars: number;
};

/** One page of the outline, cut at line ends where it can. Out-of-range parts clamp. */
export function canvasOutlinePage(
	outline: string,
	part = 1,
	size: number = CANVAS_READ_PAGE,
): CanvasPage {
	const pages: string[] = [];
	let rest = outline;
	while (rest.length > size) {
		const cut = rest.lastIndexOf("\n", size);
		const at = cut > size * 0.5 ? cut : size;
		pages.push(rest.slice(0, at));
		rest = rest.slice(at).replace(/^\n/, "");
	}
	pages.push(rest);
	const number = Math.min(Math.max(1, Math.floor(part) || 1), pages.length);
	return {
		text: pages[number - 1] ?? "",
		part: number,
		parts: pages.length,
		outlineChars: outline.length,
	};
}
