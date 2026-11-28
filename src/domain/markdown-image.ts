export type MarkdownImageSource =
	| { readonly kind: "external"; readonly url: string }
	| { readonly kind: "workspace"; readonly path: string };

/**
 * Where an image in a Markdown file lives, the way GitHub reads it: http(s)
 * URLs load as they are, `/x.png` is relative to the repository root and
 * `x.png` or `../x.png` to the Markdown file's own folder. A path that climbs
 * out of the repository, or any other scheme, has no source.
 */
export function markdownImageSource(
	markdownPath: string,
	src: string,
): MarkdownImageSource | null {
	const value = src.trim();
	if (/^https?:\/\//i.test(value)) return { kind: "external", url: value };
	if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value)) return null;
	const target = value.replace(/[?#].*$/, "");
	if (!target) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		return null;
	}
	const parts = decoded.startsWith("/")
		? []
		: markdownPath.split("/").slice(0, -1);
	for (const part of decoded.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.length ? { kind: "workspace", path: parts.join("/") } : null;
}
