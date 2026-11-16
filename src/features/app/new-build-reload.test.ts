import { describe, expect, it } from "vitest";
import {
	BUILD_CHECK_INTERVAL_MS,
	buildCheckDue,
	CHUNK_RELOAD_GUARD_MS,
	chunkReloadAllowed,
	fullNavigationOnto,
	HUB_BUILD_CONFIRM_MS,
	IDLE_BEFORE_RELOAD_MS,
	isChunkLoadFailure,
	STALE_TURN_HOLD_MS,
	safeToReload,
	TURN_IDLE_BEFORE_RELOAD_MS,
} from "./new-build-reload";

const away = {
	newBuild: true,
	sending: false,
	turnStreaming: false,
	hidden: true,
	idleMs: 0,
};

it("reloads onto a new build only when the person is away and nothing is running", () => {
	expect(safeToReload(away)).toBe(true);
	expect(
		safeToReload({ ...away, hidden: false, idleMs: IDLE_BEFORE_RELOAD_MS }),
	).toBe(true);
	// Typing or pointing within the last minute.
	expect(
		safeToReload({ ...away, hidden: false, idleMs: IDLE_BEFORE_RELOAD_MS - 1 }),
	).toBe(false);
	expect(safeToReload({ ...away, sending: true })).toBe(false);
	expect(safeToReload({ ...away, newBuild: false })).toBe(false);
});

it("lets a long working chat onto the new build once nobody is watching the turn", () => {
	const watching = {
		...away,
		turnStreaming: true,
		hidden: false,
		idleMs: IDLE_BEFORE_RELOAD_MS,
	};
	// Visible and touched a few minutes ago: they may be reading the stream.
	expect(safeToReload(watching)).toBe(false);
	// Gone for a while: the turn runs on the server, the page picks it up.
	expect(
		safeToReload({ ...watching, idleMs: TURN_IDLE_BEFORE_RELOAD_MS }),
	).toBe(true);
	// A hidden tab is never watched.
	expect(safeToReload({ ...watching, hidden: true, idleMs: 0 })).toBe(true);
	// A turn held as streaming for ages is a stale view, not a stream.
	expect(
		safeToReload({ ...watching, turnStreamingMs: STALE_TURN_HOLD_MS }),
	).toBe(true);
	// Sending still always waits.
	expect(safeToReload({ ...watching, hidden: true, sending: true })).toBe(
		false,
	);
});

it("turns the next new-page navigation into a full load, unless a send is in flight", () => {
	const push = {
		newBuild: true,
		sending: false,
		action: "PUSH",
		fromPath: "/projects/a/chats/1",
		toPath: "/projects/a/chats/2",
	};
	expect(fullNavigationOnto(push)).toBe(true);
	expect(fullNavigationOnto({ ...push, sending: true })).toBe(false);
	expect(fullNavigationOnto({ ...push, newBuild: false })).toBe(false);
	// Back/forward, search-parameter replacements and same-page pushes stay client-side.
	expect(fullNavigationOnto({ ...push, action: "BACK" })).toBe(false);
	expect(fullNavigationOnto({ ...push, action: "REPLACE" })).toBe(false);
	expect(fullNavigationOnto({ ...push, toPath: push.fromPath })).toBe(false);
});

it("recognizes a code-split file the deploy removed", () => {
	for (const message of [
		"Failed to fetch dynamically imported module: https://ytimesy.com/assets/chat-Bx1.js",
		"error loading dynamically imported module: https://ytimesy.com/assets/a.js",
		"Importing a module script failed.",
		"Unable to preload CSS for /assets/chat-Bx1.css",
	])
		expect(isChunkLoadFailure(new Error(message))).toBe(true);
	expect(isChunkLoadFailure(new Error("Cannot read properties of null"))).toBe(
		false,
	);
	expect(
		isChunkLoadFailure("Failed to fetch dynamically imported module"),
	).toBe(false);
});

it("reloads for a stale chunk at most once per guard period", () => {
	const now = 1_800_000_000_000;
	expect(chunkReloadAllowed(null, now)).toBe(true);
	expect(chunkReloadAllowed("garbage", now)).toBe(true);
	expect(chunkReloadAllowed(String(now - 1_000), now)).toBe(false);
	expect(chunkReloadAllowed(String(now - CHUNK_RELOAD_GUARD_MS), now)).toBe(
		true,
	);
});

describe("buildCheckDue", () => {
	const hub = (build?: string, open = true) => ({ open, signals: true, build });
	it("asks nothing while the hub vouches for this build, even on tab switches", () => {
		for (const visibilityChange of [true, false])
			expect(
				buildCheckDue({
					hub: hub("b1"),
					build: "b1",
					sinceCheckMs: BUILD_CHECK_INTERVAL_MS * 10,
					visibilityChange,
				}),
			).toBe(false);
	});
	it("confirms another build the hub reports, backing off while the server lags", () => {
		const due = (sinceCheckMs: number, unconfirmed: number) =>
			buildCheckDue({
				hub: hub("b2"),
				build: "b1",
				sinceCheckMs,
				visibilityChange: false,
				unconfirmed,
			});
		expect(due(HUB_BUILD_CONFIRM_MS, 0)).toBe(true);
		expect(due(HUB_BUILD_CONFIRM_MS - 1, 0)).toBe(false);
		expect(due(HUB_BUILD_CONFIRM_MS, 1)).toBe(false);
		expect(due(2 * HUB_BUILD_CONFIRM_MS, 1)).toBe(true);
		expect(due(BUILD_CHECK_INTERVAL_MS, 20)).toBe(true);
	});
	it("without the hub (or an older one), checks as before", () => {
		for (const connection of [hub(undefined), hub("b1", false)]) {
			expect(
				buildCheckDue({
					hub: connection,
					build: "b1",
					sinceCheckMs: 0,
					visibilityChange: true,
				}),
			).toBe(true);
			expect(
				buildCheckDue({
					hub: connection,
					build: "b1",
					sinceCheckMs: BUILD_CHECK_INTERVAL_MS - 1,
					visibilityChange: false,
				}),
			).toBe(false);
			expect(
				buildCheckDue({
					hub: connection,
					build: "b1",
					sinceCheckMs: BUILD_CHECK_INTERVAL_MS,
					visibilityChange: false,
				}),
			).toBe(true);
		}
	});
});
