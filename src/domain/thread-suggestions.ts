/** More chats than this (all projects), or a second project, means the user is past onboarding. */
export const RETURNING_CHAT_THRESHOLD = 3;

/**
 * Starter prompts are for a brand-new user's first project only; the Super
 * agent has its own. The first-run flag is not used: it is set before the
 * first project exists, so a new user's first project would already look returning.
 */
export function showThreadSuggestions(input: {
	readonly projectCount: number;
	readonly chatCount: number;
	readonly superAgent: boolean;
}): boolean {
	if (input.superAgent) return false;
	return input.projectCount <= 1 && input.chatCount <= RETURNING_CHAT_THRESHOLD;
}
