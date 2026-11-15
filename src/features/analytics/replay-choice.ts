/**
 * The visitor's own session-replay choice, kept in this browser. "declined"
 * is a Reject or an "off" in Cookie settings (and an old recording prompt's
 * decline still holds); "allowed" is an Accept or OK. No entry means the
 * region's default (consent-tier.ts).
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
 * Whether replay records: the page allows it (a signed-in user must have
 * accepted the current Privacy Policy), no browser signal blocks it, and the
 * visitor has not turned it off. Where consent comes first (consent-tier.ts)
 * it also needs an Accept.
 */
export function replayRecords(input: {
	readonly allowed: boolean;
	readonly block: ReplayBrowserBlock | null;
	readonly choice: ReplayChoice | null;
	/** Where replay waits for an Accept: only "allowed" records. */
	readonly consentRequired?: boolean;
}) {
	if (!input.allowed || input.block !== null) return false;
	return input.consentRequired
		? input.choice === "allowed"
		: input.choice !== "declined";
}
