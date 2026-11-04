import { expect, it } from "vitest";
import {
	CHUNK_RELOAD_GUARD_MS,
	chunkReloadAllowed,
	fullNavigationOnto,
	IDLE_BEFORE_RELOAD_MS,
	isChunkLoadFailure,
	safeToReload,
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
	expect(safeToReload({ ...away, turnStreaming: true })).toBe(false);
	expect(safeToReload({ ...away, newBuild: false })).toBe(false);
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
