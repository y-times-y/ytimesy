import type { AnyRouter } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import { BUILD_ID } from "#/lib/build-id";
import { type HubConnection, userHubStore } from "../workspace/user-hub-store";

/**
 * Open tabs move onto a new deploy by themselves, without a prompt: once the
 * server reports another build (GET /api/version), the tab reloads at the
 * first safe moment, or turns the next in-app navigation into a full page
 * load. A chunk that no longer exists after a deploy reloads the tab once.
 * The composer's draft survives every reload (session-launcher.tsx saves it
 * on pagehide).
 *
 * Quiet is for a tab nobody is using. A tab in use (typing, or watching a
 * turn stream) cannot reload unseen, so it shows a small notice at the bottom
 * right (NewVersionNotice) and the person updates when they choose.
 */

/** Whether this tab knows the server runs a newer build (drives the notice). */
let newBuildKnown = false;
const newBuildListeners = new Set<() => void>();
export function markNewBuildAvailable() {
	if (newBuildKnown) return;
	newBuildKnown = true;
	for (const listener of newBuildListeners) listener();
}
export function useNewBuildAvailable(): boolean {
	return useSyncExternalStore(
		(listener) => {
			newBuildListeners.add(listener);
			return () => newBuildListeners.delete(listener);
		},
		() => newBuildKnown,
		() => false,
	);
}

/** How often a visible tab asks the server which build it runs. */
export const BUILD_CHECK_INTERVAL_MS = 5 * 60_000;
/** How often the check repeats while the hub reports a build the server does not run yet. */
export const HUB_BUILD_CONFIRM_MS = 30_000;

/**
 * Whether the tab asks the server (GET /api/version) which build it runs.
 * While the user's hub delivers and reported a build, it does the asking: a
 * deploy restarts the hub, and the reconnect's whole map carries the new
 * build. The hub's build is then confirmed by the server (the edge may be
 * up before the web Worker): after HUB_BUILD_CONFIRM_MS, then twice as long
 * after each answer that still names this tab's build, up to
 * BUILD_CHECK_INTERVAL_MS (an edge left on another build never polls faster).
 * Without the hub: every BUILD_CHECK_INTERVAL_MS, and on leaving or coming
 * back to the tab.
 */
export function buildCheckDue(input: {
	readonly hub: HubConnection;
	readonly build: string;
	readonly sinceCheckMs: number;
	/** Leaving or coming back to the tab. */
	readonly visibilityChange: boolean;
	/** Server answers so far that named this tab's build while the hub named another. */
	readonly unconfirmed?: number;
}): boolean {
	if (input.hub.open && input.hub.build) {
		if (input.hub.build === input.build) return false;
		return (
			input.sinceCheckMs >=
			Math.min(
				HUB_BUILD_CONFIRM_MS * 2 ** (input.unconfirmed ?? 0),
				BUILD_CHECK_INTERVAL_MS,
			)
		);
	}
	return (
		input.visibilityChange || input.sinceCheckMs >= BUILD_CHECK_INTERVAL_MS
	);
}
/** No typing or pointer for this long counts as away from the tab. */
export const IDLE_BEFORE_RELOAD_MS = 60_000;
/** At most one stale-chunk reload this often, so a broken deploy cannot loop. */
export const CHUNK_RELOAD_GUARD_MS = 30_000;
const CHUNK_RELOAD_AT_KEY = "ytimesy-chunk-reload-at";

/**
 * While a model turn streams in the open chat and the person is plausibly
 * reading it (the tab is visible and they touched it within this long), the
 * reload waits. Past it, or in a hidden tab, nobody is watching: the turn runs
 * on the server, and the reloaded page picks its progress up.
 */
export const TURN_IDLE_BEFORE_RELOAD_MS = 10 * 60_000;
/**
 * A "turn is streaming" hold older than this is a stale one (a view that kept
 * saying running after the turn ended): it never keeps a tab on an old build.
 */
export const STALE_TURN_HOLD_MS = 30 * 60_000;

/** What a reload would interrupt right now. */
type ReloadHold = "send" | "turn";
const holds: Record<ReloadHold, number> = { send: 0, turn: 0 };
/** When each hold last went from none to one: how long it has been continuously held. */
const heldSince: Record<ReloadHold, number> = { send: 0, turn: 0 };

/**
 * Whether the tab may reload onto the new build now: the server runs
 * another build, nothing is being sent, and the person is away (tab hidden,
 * or idle for a minute, so never mid-typing). A turn streaming in the open
 * chat holds the reload only while the person is plausibly watching it (see
 * TURN_IDLE_BEFORE_RELOAD_MS) and the hold is not stale: a long working chat
 * must not stay on an old build for the whole session. Never a prompt: the
 * reload happens when it cannot be noticed.
 */
export function safeToReload(input: {
	readonly newBuild: boolean;
	readonly sending: boolean;
	readonly turnStreaming: boolean;
	/** How long the turn has been held as streaming without a break. */
	readonly turnStreamingMs?: number;
	readonly hidden: boolean;
	readonly idleMs: number;
}) {
	if (!input.newBuild || input.sending) return false;
	if (
		input.turnStreaming &&
		!input.hidden &&
		input.idleMs < TURN_IDLE_BEFORE_RELOAD_MS &&
		(input.turnStreamingMs ?? 0) < STALE_TURN_HOLD_MS
	)
		return false;
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
		if (holds[hold] === 0) heldSince[hold] = Date.now();
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
	let unconfirmed = 0;
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
				turnStreamingMs: holds.turn > 0 ? Date.now() - heldSince.turn : 0,
				hidden: document.visibilityState === "hidden",
				idleMs: Date.now() - lastActiveAt,
			})
		)
			window.location.reload();
	};
	const check = async (visibilityChange = false) => {
		if (
			!newBuild &&
			buildCheckDue({
				hub: userHubStore.connection(),
				build: BUILD_ID,
				sinceCheckMs: Date.now() - checkedAt,
				visibilityChange,
				unconfirmed,
			})
		) {
			checkedAt = Date.now();
			const build = await serverBuild();
			if (build && build !== BUILD_ID) {
				newBuild = true;
				markNewBuildAvailable();
				blockNextNavigation();
			} else {
				const hub = userHubStore.connection();
				if (hub.open && hub.build && hub.build !== BUILD_ID) unconfirmed += 1;
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
		void check(true);
	});
	// A local timer: it only asks the server when buildCheckDue says so (never
	// while the hub vouches for this build), or reloads once that is safe.
	window.setInterval(() => void check(), 30_000);
	// The hub reporting another build checks at once.
	userHubStore.subscribe(() => {
		const hub = userHubStore.connection();
		if (hub.open && hub.build && hub.build !== BUILD_ID) void check();
	});
}
