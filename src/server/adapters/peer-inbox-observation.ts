/**
 * Whether a chat's inbox (peer messages and queued user sends) may hold
 * anything, learned for free from the turn heartbeat, which already updates
 * the turn every second and now also reports whether an unaccepted inbox row
 * exists. A negative answer from a statement that started at `at` proves the
 * inbox was empty of everything committed before `at`, so the step can skip
 * its own inbox read while that answer is fresh. Anything committed after it
 * is read by the next step's check, as a message arriving during the model
 * request already is; nothing is dropped.
 */
const FRESH_MS = 1_500;
const observations = new Map<string, { at: number; pending: boolean }>();

export function observePeerInbox(
	sessionId: string,
	at: number,
	pending: boolean,
) {
	const previous = observations.get(sessionId);
	if (previous && previous.at > at) return;
	observations.set(sessionId, { at, pending });
	if (observations.size > 1_000)
		for (const [id, seen] of observations)
			if (at - seen.at > FRESH_MS) observations.delete(id);
}

/** False only when a fresh heartbeat found nothing waiting. */
export function peerInboxMayHaveMessages(sessionId: string, now = Date.now()) {
	const seen = observations.get(sessionId);
	if (!seen || seen.pending) return true;
	return now - seen.at > FRESH_MS || now < seen.at;
}

/**
 * A write to the inbox from this isolate voids its own observation at once
 * (writes from other isolates wait for the next heartbeat or step).
 */
export function forgetPeerInboxObservation(sessionId: string) {
	observations.delete(sessionId);
}
