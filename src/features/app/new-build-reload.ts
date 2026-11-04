import type { AnyRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { BUILD_ID } from "#/lib/build-id";

/**
 * Open tabs move onto a new deploy by themselves, without a prompt: once the
 * server reports another build (GET /api/version), the tab reloads at the
 * first safe moment, or turns the next in-app navigation into a full page
 * load. A chunk that no longer exists after a deploy reloads the tab once.
 * The composer's draft survives every reload (session-launcher.tsx saves it
 * on pagehide).
 */

/** How often a visible tab asks the server which build it runs. */
export const BUILD_CHECK_INTERVAL_MS = 5 * 60_000;
/** No typing or pointer for this long counts as away from the tab. */
export const IDLE_BEFORE_RELOAD_MS = 60_000;
/** At most one stale-chunk reload this often, so a broken deploy cannot loop. */
export const CHUNK_RELOAD_GUARD_MS = 30_000;
const CHUNK_RELOAD_AT_KEY = "ytimesy-chunk-reload-at";

/** What a reload would interrupt right now. */
type ReloadHold = "send" | "turn";
const holds: Record<ReloadHold, number> = { send: 0, turn: 0 };

/**
 * Whether the tab may reload onto the new build now: the server runs
 * another build, nothing is being sent, no model turn streams in the open
 * chat, and the person is away (tab hidden, or idle for a minute, so never
 * mid-typing).
 */
export function safeToReload(input: {
	readonly newBuild: boolean;
	readonly sending: boolean;
	readonly turnStreaming: boolean;
	readonly hidden: boolean;
	readonly idleMs: number;
}) {
	if (!input.newBuild || input.sending || input.turnStreaming) return false;
	return input.hidden || input.idleMs >= IDLE_BEFORE_RELOAD_MS;
}

/**
 * Whether an in-app navigation becomes a full page load onto the new build:
 * a new page (push) while nothing is being sent. Back/forward and in-place
 * replacements (a search parameter) stay client transitions.
 */
export function fullNavigationOnto(input: {
	readonly newBuild: boolean;
	readonly sending: boolean;
	readonly action: string;
	readonly fromPath: string;
	readonly toPath: string;
}) {
	return (
		input.newBuild &&
		!input.sending &&
		input.action === "PUSH" &&
		input.fromPath !== input.toPath
	);
}

/** A failure to load a code-split JS or CSS file, as browsers and Vite word it. */
const CHUNK_LOAD_FAILURE =
	/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isChunkLoadFailure(error: unknown) {
	return error instanceof Error && CHUNK_LOAD_FAILURE.test(error.message);
}

/** Whether a stale-chunk reload may run, given the last one's time (sessionStorage). */
export function chunkReloadAllowed(lastAt: string | null, nowMs: number) {
	const last = Number(lastAt);
	return (
		!lastAt || !Number.isFinite(last) || nowMs - last >= CHUNK_RELOAD_GUARD_MS
	);
}

/**
 * Holds the new-build reload while `active`: "send" while a message is being
 * sent (also keeps navigations client-side), "turn" while the open chat's
 * model turn streams.
 */
export function useHoldNewBuildReload(hold: ReloadHold, active: boolean) {
	useEffect(() => {
		if (!active) return;
		holds[hold]++;
		return () => {
			holds[hold]--;
		};
	}, [hold, active]);
}

/**
 * Reloads once when a code-split file fails to load (the deploy removed it),
 * unless a reload for that already ran in the last CHUNK_RELOAD_GUARD_MS; then
 * the error surfaces as it would have. Install before hydration.
 */
export function recoverFromStaleChunks() {
	const reloadOnce = () => {
		try {
			const storage = window.sessionStorage;
			if (!chunkReloadAllowed(storage.getItem(CHUNK_RELOAD_AT_KEY), Date.now()))
				return false;
			storage.setItem(CHUNK_RELOAD_AT_KEY, String(Date.now()));
		} catch {
			// Without storage there is no loop guard: let the error surface.
			return false;
		}
		window.location.reload();
		return true;
	};
	window.addEventListener("vite:preloadError", (event) => {
		if (reloadOnce()) event.preventDefault();
	});
	window.addEventListener("unhandledrejection", (event) => {
		if (isChunkLoadFailure(event.reason) && reloadOnce())
			event.preventDefault();
	});
}

async function serverBuild(): Promise<string | null> {
	try {
		const response = await fetch("/api/version", { cache: "no-store" });
		if (!response.ok) return null;
		const body: unknown = await response.json();
		return body && typeof body === "object" && "build" in body
			? String(body.build)
			: null;
	} catch {
		return null;
	}
}

/**
 * Watches for a newer deploy and moves this tab onto it (see the top of
 * this file). Off on the dev server, whose page and server are one build.
 */
export function watchForNewBuild(router: AnyRouter) {
	if (BUILD_ID === "development") return;
	let newBuild = false;
	let checkedAt = Date.now();
	let lastActiveAt = Date.now();
	const active = () => {
		lastActiveAt = Date.now();
	};
	for (const type of ["keydown", "input", "pointerdown", "wheel", "touchstart"])
		window.addEventListener(type, active, { capture: true, passive: true });

	const reloadIfSafe = () => {
		if (
			safeToReload({
				newBuild,
				sending: holds.send > 0,
				turnStreaming: holds.turn > 0,
				hidden: document.visibilityState === "hidden",
				idleMs: Date.now() - lastActiveAt,
			})
		)
			window.location.reload();
	};
	const check = async () => {
		if (!newBuild) {
			checkedAt = Date.now();
			const build = await serverBuild();
			if (build && build !== BUILD_ID) {
				newBuild = true;
				blockNextNavigation();
			}
		}
		reloadIfSafe();
	};
	const blockNextNavigation = () => {
		let release = () => {};
		release = router.history.block({
			blockerFn: ({
				currentLocation,
				nextLocation,
				action,
			}: {
				currentLocation: { pathname: string };
				nextLocation: { pathname: string; href: string };
				action: string;
			}) => {
				if (
					!fullNavigationOnto({
						newBuild,
						sending: holds.send > 0,
						action,
						fromPath: currentLocation.pathname,
						toPath: nextLocation.pathname,
					})
				)
					return false;
				release();
				window.location.assign(nextLocation.href);
				return true;
			},
			enableBeforeUnload: false,
		});
	};

	// Leaving the tab is the best moment: check, and reload if it is newer.
	// Coming back counts as activity, so the tab never reloads under the
	// person's first keystroke.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") active();
		void check();
	});
	window.setInterval(() => {
		if (!newBuild && Date.now() - checkedAt < BUILD_CHECK_INTERVAL_MS) return;
		void check();
	}, 30_000);
}
