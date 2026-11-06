/**
 * An address that existed once and was removed on purpose (an old developer
 * docs page the search engines still list). 410 tells them to drop it sooner
 * than a 404 does; X-Robots-Tag covers a crawler that reads headers first.
 */
export function goneResponse() {
	return new Response("This page has been removed.", {
		status: 410,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"X-Robots-Tag": "noindex",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
