/**
 * Signed-in sessions this isolate checked against the database recently.
 *
 * Every server function used to look its caller's session up in the
 * database (the session row, then its user: two round trips). A browser
 * makes many calls a minute with the same cookie, so this isolate keeps what
 * Better Auth answered for a cookie for SESSION_CACHE_TTL_MS.
 *
 * Why this is safe:
 * - The key is the exact session cookie value the browser sent, signature
 *   included. Only a value Better Auth itself accepted (signature verified,
 *   session row found, not expired) is ever stored, so a hit can only repeat
 *   a decision the database already made. Failures are never cached.
 * - An entry lives at most SESSION_CACHE_TTL_MS and never past the
 *   session's own expiry.
 * - Ending a session drops it here at once: Better Auth's session and user
 *   delete hooks (sign-out, revoking sessions, password reset, deleting the
 *   user) and account deletion call forgetSession / forgetUserSessions.
 *   Another isolate that cached the same cookie keeps it until its TTL ends,
 *   so a revocation reaches every isolate within SESSION_CACHE_TTL_MS.
 * - Memory is per isolate and never shared between users: nothing here is
 *   written to KV, cookies or any shared store.
 */
export const SESSION_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 1_000;

type CachedSession<S> = {
	readonly value: S;
	readonly token: string;
	readonly userId: string;
	readonly until: number;
};

type SessionShape = {
	readonly session: {
		readonly token: string;
		readonly expiresAt: Date | string;
	};
	readonly user: { readonly id: string };
};

const entries = new Map<string, CachedSession<SessionShape>>();

const SESSION_COOKIE = /^(?:__Secure-|__Host-)?better-auth\.session_token$/;

/**
 * The session cookie(s) exactly as sent, or null without one. Every other
 * cookie is ignored, so unrelated cookies do not split the cache.
 */
export function sessionCacheKey(headers: Headers): string | null {
	const cookie = headers.get("cookie");
	if (!cookie) return null;
	const parts: string[] = [];
	for (const pair of cookie.split(";")) {
		const index = pair.indexOf("=");
		if (index < 0) continue;
		const name = pair.slice(0, index).trim();
		if (SESSION_COOKIE.test(name))
			parts.push(`${name}=${pair.slice(index + 1).trim()}`);
	}
	return parts.length ? parts.sort().join(";") : null;
}

export function cachedSession<S extends SessionShape>(
	key: string,
	now = Date.now(),
): S | undefined {
	const entry = entries.get(key);
	if (!entry) return undefined;
	if (entry.until <= now) {
		entries.delete(key);
		return undefined;
	}
	return entry.value as S;
}

export function rememberSession(
	key: string,
	value: SessionShape,
	now = Date.now(),
) {
	const expires = new Date(value.session.expiresAt).getTime();
	const until = Math.min(
		now + SESSION_CACHE_TTL_MS,
		Number.isFinite(expires) ? expires : now,
	);
	if (until <= now) return;
	entries.delete(key);
	entries.set(key, {
		value,
		token: value.session.token,
		userId: value.user.id,
		until,
	});
	// Oldest first: Map keeps insertion order.
	while (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
}

/** One session ended (sign-out, revoked): its cookie must be checked again. */
export function forgetSession(token: string) {
	for (const [key, entry] of entries)
		if (entry.token === token) entries.delete(key);
}

/** Every session of this user ended or the user is gone. */
export function forgetUserSessions(userId: string) {
	for (const [key, entry] of entries)
		if (entry.userId === userId) entries.delete(key);
}

/** Test seam. */
export function forgetAllSessions() {
	entries.clear();
}
