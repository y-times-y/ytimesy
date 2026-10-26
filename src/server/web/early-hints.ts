import type {
	ResponseLinkHeaderEntry,
	ResponseLinkHeaderOptions,
} from "@tanstack/react-start/server";

/**
 * HTML responses carry `Link` headers for the page's stylesheets, script
 * chunks, font and third-party preconnects. With Early Hints on for the zone,
 * Cloudflare caches them per URL and sends them as a 103 before the Worker
 * answers, so the browser fetches those files while the page renders.
 *
 * Cloudflare can send a cached 103 before the Worker runs, even to a visitor
 * who is not signed in, so only public, build-hashed assets and preconnects
 * qualify: never a URL that could carry user data.
 */
export function earlyHintLink({ hint }: ResponseLinkHeaderEntry): boolean {
	if (hint.rel === "preconnect") return /^https:\/\/[^/]+$/.test(hint.href);
	return hint.href.startsWith("/assets/");
}

export const EARLY_HINT_LINKS: ResponseLinkHeaderOptions = {
	filter: earlyHintLink,
};
