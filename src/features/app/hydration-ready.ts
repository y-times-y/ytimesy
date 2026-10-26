import type { AnyRouter } from "@tanstack/react-router";
import { markdownRenderer } from "../sessions/agent-markdown";

/**
 * Waits until React can hydrate the server HTML without suspending: the
 * streamed response has ended, the loaders' streamed values (a chat read
 * after the first bytes) have arrived, and the Markdown renderer has loaded
 * if the page shows Markdown.
 *
 * Anything that suspends while hydrating leaves its Suspense boundary
 * dehydrated, and the first update from above (the theme, the session, the
 * router) then makes React drop that server HTML and render it again from
 * scratch: the page without its chat, replies as plain text, then the
 * final page. Until React hydrates, the server HTML is the page.
 */
export async function readyToHydrate(router: AnyRouter): Promise<void> {
	if (document.readyState === "loading")
		await new Promise((resolve) =>
			document.addEventListener("DOMContentLoaded", resolve, { once: true }),
		);
	const streamed = router.state.matches.flatMap((match) =>
		Object.values((match.loaderData ?? {}) as Record<string, unknown>).filter(
			(value): value is Promise<unknown> => value instanceof Promise,
		),
	);
	await Promise.all([
		...streamed.map(settledForUse),
		document.querySelector(".session-markdown") ? markdownRenderer() : null,
	]);
}

/** Settles the promise and marks it the way React's `use` reads without suspending. */
function settledForUse(promise: Promise<unknown>) {
	return promise.then(
		(value) => {
			Object.assign(promise, { status: "fulfilled", value });
		},
		(reason: unknown) => {
			Object.assign(promise, { status: "rejected", reason });
		},
	);
}
