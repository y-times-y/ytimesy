/**
 * The visitor's own session-replay choice, kept in this browser. "declined"
 * was written by the old recording prompt and still holds; "allowed" is a
 * later "on" in Privacy choices. No entry means the default for the region.
 */
export const REPLAY_CHOICE_KEY = "ytimesy.replay-consent";
export type ReplayChoice = "declined" | "allowed";

/** Fired on window when the choice changes in this tab. */
export const REPLAY_CHOICE_EVENT = "ytimesy:replay-choice";

export function readReplayChoice(): ReplayChoice | null {
	try {
		const value = globalThis.localStorage?.getItem(REPLAY_CHOICE_KEY);
		return value === "declined" || value === "allowed" ? value : null;
	} catch {
		return null;
	}
}

export function writeReplayChoice(choice: ReplayChoice) {
	try {
		globalThis.localStorage?.setItem(REPLAY_CHOICE_KEY, choice);
	} catch {
		// Storage refused (private mode): the choice holds for this page.
	}
	globalThis.window?.dispatchEvent?.(new Event(REPLAY_CHOICE_EVENT));
}

/** A browser privacy signal that keeps replay off whatever the choice. */
export type ReplayBrowserBlock = "do-not-track" | "global-privacy-control";

export function replayBrowserBlock(
	nav: Pick<Navigator, "doNotTrack"> & {
		readonly globalPrivacyControl?: boolean;
	} = globalThis.navigator,
): ReplayBrowserBlock | null {
	if (!nav) return null;
	if (nav.doNotTrack === "1") return "do-not-track";
	if (nav.globalPrivacyControl === true) return "global-privacy-control";
	return null;
}

/**
 * Whether replay records: the page allows it (region, and for a signed-in
 * user the current Privacy Policy), no browser signal blocks it, and the
 * visitor has not turned it off.
 */
export function replayRecords(input: {
	readonly allowed: boolean;
	readonly block: ReplayBrowserBlock | null;
	readonly choice: ReplayChoice | null;
}) {
	return input.allowed && input.block === null && input.choice !== "declined";
}
