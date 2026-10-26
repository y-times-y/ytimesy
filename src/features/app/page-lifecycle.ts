import { useSyncExternalStore } from "react";

/**
 * Open connections (the chat's progress stream, the terminal and desktop
 * sockets) keep the browser from putting the page in its back/forward cache,
 * so Back and Forward reload the whole app instead of showing it instantly.
 * Connections close when the page is hidden for navigation and reopen when
 * the page comes back from that cache.
 */

let restores = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
	if (!listeners.size) window.addEventListener("pageshow", onPageShow);
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (!listeners.size) window.removeEventListener("pageshow", onPageShow);
	};
}

function onPageShow(event: PageTransitionEvent) {
	if (!event.persisted) return;
	restores++;
	for (const listener of listeners) listener();
}

/**
 * How many times this page has come back from the back/forward cache. Add it
 * to a connection effect's dependencies so the effect opens a fresh
 * connection after a restore.
 */
export function usePageRestores(): number {
	return useSyncExternalStore(
		subscribe,
		() => restores,
		() => 0,
	);
}

/**
 * Runs `close` when the page is hidden for navigation (and not again later),
 * so the page stays eligible for the back/forward cache. Returns a cleanup
 * for the effect that also runs `close` once.
 */
export function closeOnPageHide(close: () => void): () => void {
	let closed = false;
	const closeOnce = () => {
		if (closed) return;
		closed = true;
		window.removeEventListener("pagehide", closeOnce);
		close();
	};
	window.addEventListener("pagehide", closeOnce);
	return closeOnce;
}
