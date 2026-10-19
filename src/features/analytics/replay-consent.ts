/**
 * Session replay runs only after the visitor accepts it (EU/UK consent for
 * non-essential recording; applied to every visitor for simplicity). The
 * choice lives in this browser's localStorage. Product events and error
 * capture are not covered by this choice.
 */
export type ReplayConsent = "accepted" | "declined";

export const REPLAY_CONSENT_KEY = "ytimesy.replay-consent";

const listeners = new Set<(choice: ReplayConsent | null) => void>();

/** Null when the visitor has not chosen, or storage is unavailable. */
export function readReplayConsent(): ReplayConsent | null {
	try {
		const value = globalThis.localStorage?.getItem(REPLAY_CONSENT_KEY);
		return value === "accepted" || value === "declined" ? value : null;
	} catch {
		return null;
	}
}

export function saveReplayConsent(choice: ReplayConsent) {
	try {
		globalThis.localStorage?.setItem(REPLAY_CONSENT_KEY, choice);
	} catch {
		// Without storage the choice holds for this page only.
	}
	for (const listener of listeners) listener(choice);
}

export function onReplayConsentChange(
	listener: (choice: ReplayConsent | null) => void,
) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
