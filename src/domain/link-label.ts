/**
 * The label a link should show. A label that is only the link's domain
 * ("github.com") hides where it goes, so it becomes the address without the
 * scheme: "github.com/acme/app/pull/12". Any other label is kept.
 */
export function linkLabel(label: string, href: string): string | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
	const text = label
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/$/, "");
	if (bare(text) !== bare(url.hostname)) return null;
	const rest = `${url.pathname.replace(/\/$/, "")}${url.search}${url.hash}`;
	return rest ? `${bare(url.host)}${rest}` : null;
}
