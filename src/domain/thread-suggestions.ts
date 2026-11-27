export type SuggestionPref = "show" | "hide";

/** More chats than this (all projects), or a second project, means the user is past onboarding. */
export const RETURNING_CHAT_THRESHOLD = 3;

export function parseSuggestionPref(value: unknown): SuggestionPref | null {
	return value === "show" || value === "hide" ? value : null;
}

/**
 * "shown": the starter prompts; "offer": only a quiet "Show suggestions" link;
 * "none": nothing (the Super agent has its own). The first-run flag is not
 * used: it is set before the first project exists, so a new user's first
 * project would already look returning.
 */
export function threadSuggestionsState(input: {
	readonly pref: SuggestionPref | null;
	readonly projectCount: number;
	readonly chatCount: number;
	readonly superAgent: boolean;
}): "shown" | "offer" | "none" {
	if (input.superAgent) return "none";
	if (input.pref) return input.pref === "show" ? "shown" : "offer";
	const returning =
		input.projectCount > 1 || input.chatCount > RETURNING_CHAT_THRESHOLD;
	return returning ? "offer" : "shown";
}
