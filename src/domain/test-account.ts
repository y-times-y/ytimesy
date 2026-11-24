/**
 * The synthetic test account (docs/testing-live.md). Every rule that keeps it
 * safe is here as plain functions: the server wiring in
 * server/services/test-account.ts only supplies the clock and the database.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** A fixed id, so analytics, email and billing can skip it without a lookup. */
export const TEST_ACCOUNT_ID = "ytimesy-test-account";
/** `.test` is reserved (RFC 6761): mail to it can never be delivered. */
export const TEST_ACCOUNT_EMAIL = "ytimesy-test@example.test";
export const TEST_ACCOUNT_NAME = "ytimesy test account";
export const TEST_SESSION_TTL_SECONDS = 15 * 60;
export const TEST_SESSION_MAX_PER_HOUR = 30;
export const TEST_SESSION_CALLER_MAX = 120;

export function isTestAccountId(userId: string | null | undefined) {
	return userId === TEST_ACCOUNT_ID;
}

/** Mail to the reserved `.test` TLD is never sent. */
export function isTestAddress(email: string) {
	return /@[^@]+\.test$/i.test(email.trim());
}

/**
 * The capability token an agent holds. Derived from the signing root and a
 * version, so no one pastes it: bump the version to revoke every copy.
 */
export function deriveTestSessionToken(root: string, version: string) {
	return createHmac("sha256", root)
		.update(`ytimesy:test-session:${version}`)
		.digest("hex");
}

/** The Worker stores only this hash. */
export function hashTestSessionToken(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(presented: string, expectedHash: string) {
	const a = Buffer.from(hashTestSessionToken(presented), "hex");
	const b = Buffer.from(expectedHash, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

/** A caller label (thread or chat id): short, printable, never empty. */
export function normalizeCaller(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const caller = raw.trim();
	if (!caller || caller.length > TEST_SESSION_CALLER_MAX) return null;
	return /^[\w .:@/#-]+$/.test(caller) ? caller : null;
}

export type MintRefusal =
	| "not-configured"
	| "bad-token"
	| "bad-caller"
	| "rate-limited"
	| "user-is-not-test-account";

export function mintRefusal(input: {
	expectedHash: string | undefined;
	presentedToken: string | undefined;
	caller: string | null;
	mintedLastHour: number;
}): MintRefusal | null {
	if (!input.expectedHash) return "not-configured";
	if (
		!input.presentedToken ||
		!tokenMatches(input.presentedToken, input.expectedHash)
	)
		return "bad-token";
	if (!input.caller) return "bad-caller";
	if (input.mintedLastHour >= TEST_SESSION_MAX_PER_HOUR) return "rate-limited";
	return null;
}

/** Better Auth's session cookie: the token and its HMAC, URL-encoded. */
export function signedSessionCookie(
	token: string,
	secret: string,
	secure: boolean,
) {
	const signature = createHmac("sha256", secret).update(token).digest("base64");
	return {
		name: `${secure ? "__Secure-" : ""}better-auth.session_token`,
		value: encodeURIComponent(`${token}.${signature}`),
	};
}
