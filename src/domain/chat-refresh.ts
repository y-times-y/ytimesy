/**
 * A chat opened from the browser's saved copy shows that copy at once and
 * replaces it with the server's when it arrives. Until then what it shows
 * (a spinner, "working", an agent counted as running) may be old.
 */
export function chatIsRefreshing(input: {
	/** A chat is open and something of it is on screen. */
	readonly shown: boolean;
	/** The open's first server read has not landed. */
	readonly firstReadPending: boolean;
	/** That read is actually under way (not held back by a draft or a send). */
	readonly reading: boolean;
}): boolean {
	return input.shown && input.firstReadPending && input.reading;
}
