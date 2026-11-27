import { useCallback, useSyncExternalStore } from "react";
import {
	parseSuggestionPref,
	type SuggestionPref,
} from "#/domain/thread-suggestions";

export const suggestionPrefKey = (userId: string) =>
	`ytimesy.thread-suggestions.${userId}`;

const CHANGED = "ytimesy:thread-suggestions";

export function readSuggestionPref(
	storage: Pick<Storage, "getItem">,
	userId: string,
): SuggestionPref | null {
	try {
		return parseSuggestionPref(storage.getItem(suggestionPrefKey(userId)));
	} catch {
		return null;
	}
}

export function writeSuggestionPref(
	storage: Pick<Storage, "setItem">,
	userId: string,
	pref: SuggestionPref,
) {
	try {
		storage.setItem(suggestionPrefKey(userId), pref);
	} catch {
		// A browser that refuses storage keeps the choice until reload.
	}
}

function subscribe(notify: () => void) {
	window.addEventListener("storage", notify);
	window.addEventListener(CHANGED, notify);
	return () => {
		window.removeEventListener("storage", notify);
		window.removeEventListener(CHANGED, notify);
	};
}

/**
 * The user's choice, kept in this browser per account (like the setup card's).
 * "loading" on the server and the hydrating render, so the first paint is the
 * same everywhere and nothing snaps; the caller reserves the space meanwhile.
 */
export function useSuggestionPref(userId: string | undefined) {
	const pref = useSyncExternalStore<SuggestionPref | "none" | "loading">(
		subscribe,
		() =>
			userId ? (readSuggestionPref(localStorage, userId) ?? "none") : "none",
		() => "loading",
	);
	const set = useCallback(
		(next: SuggestionPref) => {
			if (!userId) return;
			writeSuggestionPref(localStorage, userId, next);
			window.dispatchEvent(new Event(CHANGED));
		},
		[userId],
	);
	return {
		loading: pref === "loading",
		pref: pref === "show" || pref === "hide" ? pref : null,
		set,
	};
}
