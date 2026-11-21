import { z } from "zod";

/**
 * Capabilities of the thin-client edge API for turn runner boxes
 * (docs/turn-runner-boxes.md). A box holds no production secret: only the
 * edge's PUBLIC key and a revocable identity token. Both are Ed25519
 * signatures made by the edge (which alone holds the private key):
 *
 * - box identity: `ytbi1.<b64url {b,e,n}>.<b64url sig>`, long-lived but
 *   revocable (turn_runner_box.revoked_at); lets a box ask the edge to claim.
 * - turn grant: `ytbg1.<b64url {u,s,t,l,b,e,n}>.<b64url sig>` for ONE turn
 *   under ONE lease on ONE box, valid 10 minutes and renewed with the lease
 *   heartbeat. The signature lets the box (and tests) check authenticity; the
 *   authority is still the edge's lease-checked SQL, so a stale grant of a
 *   zombie box writes nothing.
 *
 * Domain separation: the signed bytes include the prefix, so an identity can
 * never verify as a grant. Uses only WebCrypto (Workers, Node, browsers).
 */
const GRANT_PREFIX = "ytbg1";
const IDENTITY_PREFIX = "ytbi1";
const MAX_LENGTH = 1024;
export const TURN_BOX_GRANT_TTL_MS = 10 * 60 * 1000;
/** A grant with less than this left is replaced in the heartbeat response. */
export const TURN_BOX_GRANT_REFRESH_MS = 5 * 60 * 1000;
export const TURN_BOX_IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;
export const TURN_BOX_IDENTITY_REFRESH_MS = 60 * 60 * 1000;

const nonce = z.string().regex(/^[a-f0-9]{16}$/);
const boxId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const grantPayload = z
	.object({
		u: z.string().min(1).max(128),
		s: z.uuid(),
		t: z.uuid(),
		l: z.uuid(),
		b: boxId,
		e: z.number().int().positive(),
		n: nonce,
	})
	.strict();
const identityPayload = z
	.object({ b: boxId, e: z.number().int().positive(), n: nonce })
	.strict();

export type TurnBoxGrant = {
	readonly userId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly leaseId: string;
	readonly boxId: string;
	readonly expiresAt: number;
	readonly nonce: string;
};
export type TurnBoxIdentity = {
	readonly boxId: string;
	readonly expiresAt: number;
	readonly nonce: string;
};

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64(text: string, url: boolean) {
	if (!(url ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9+/]*={0,2}$/).test(text))
		return null;
	const padded = url ? text.replaceAll("-", "+").replaceAll("_", "/") : text;
	try {
		return Uint8Array.from(
			atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
			(character) => character.charCodeAt(0),
		);
	} catch {
		return null;
	}
}

function randomNonce() {
	return Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
}

/** The edge's signing key: PKCS#8 bytes, base64 (standard alphabet). */
async function privateKey(pkcs8Base64: string) {
	const bytes = fromBase64(pkcs8Base64, false);
	if (!bytes) throw new Error("Turn box signing key is not base64.");
	return crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"]);
}

/** The edge's public key: 32 raw bytes, base64 (what a box is configured with). */
async function publicKey(rawBase64: string) {
	const bytes = fromBase64(rawBase64, false);
	if (bytes?.byteLength !== 32) return null;
	return crypto.subtle.importKey("raw", bytes, "Ed25519", false, ["verify"]);
}

/** A new keypair for provisioning: private as PKCS#8 base64, public as raw base64. */
export async function generateTurnBoxKeyPair() {
	const pair = (await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const std = (bytes: ArrayBuffer) =>
		btoa(String.fromCharCode(...new Uint8Array(bytes)));
	return {
		privateKey: std(
			(await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
		),
		publicKey: std(
			(await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
		),
	};
}

async function sign(
	privateKeyBase64: string,
	prefix: string,
	payload: unknown,
) {
	const body = base64url(encoder.encode(JSON.stringify(payload)));
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"Ed25519",
			await privateKey(privateKeyBase64),
			encoder.encode(`${prefix}.${body}`),
		),
	);
	return `${prefix}.${body}.${base64url(signature)}`;
}

async function open(
	publicKeyBase64: string,
	prefix: string,
	value: string | null | undefined,
): Promise<unknown | null> {
	if (!value || value.length > MAX_LENGTH) return null;
	const parts = value.split(".");
	if (parts.length !== 3 || parts[0] !== prefix) return null;
	const [, body, signature] = parts as [string, string, string];
	const signatureBytes = fromBase64(signature, true);
	const bodyBytes = fromBase64(body, true);
	const key = await publicKey(publicKeyBase64);
	if (signatureBytes?.byteLength !== 64 || !bodyBytes || !key) return null;
	const valid = await crypto.subtle.verify(
		"Ed25519",
		key,
		signatureBytes,
		encoder.encode(`${prefix}.${body}`),
	);
	if (!valid) return null;
	try {
		return JSON.parse(new TextDecoder().decode(bodyBytes));
	} catch {
		return null;
	}
}

export async function issueTurnBoxGrant(
	privateKeyBase64: string,
	input: Omit<TurnBoxGrant, "expiresAt" | "nonce"> & {
		readonly expiresAt?: number;
	},
	now = Date.now(),
) {
	return sign(
		privateKeyBase64,
		GRANT_PREFIX,
		grantPayload.parse({
			u: input.userId,
			s: input.sessionId,
			t: input.turnId,
			l: input.leaseId,
			b: input.boxId,
			e: input.expiresAt ?? now + TURN_BOX_GRANT_TTL_MS,
			n: randomNonce(),
		}),
	);
}

/** The grant a value carries, or null when malformed, forged or expired. */
export async function verifyTurnBoxGrant(
	publicKeyBase64: string,
	value: string | null | undefined,
	now = Date.now(),
): Promise<TurnBoxGrant | null> {
	const parsed = grantPayload.safeParse(
		await open(publicKeyBase64, GRANT_PREFIX, value),
	);
	if (!parsed.success || parsed.data.e <= now) return null;
	const { u, s, t, l, b, e, n } = parsed.data;
	return {
		userId: u,
		sessionId: s,
		turnId: t,
		leaseId: l,
		boxId: b,
		expiresAt: e,
		nonce: n,
	};
}

export async function issueTurnBoxIdentity(
	privateKeyBase64: string,
	input: { readonly boxId: string; readonly expiresAt?: number },
	now = Date.now(),
) {
	return sign(
		privateKeyBase64,
		IDENTITY_PREFIX,
		identityPayload.parse({
			b: input.boxId,
			e: input.expiresAt ?? now + TURN_BOX_IDENTITY_TTL_MS,
			n: randomNonce(),
		}),
	);
}

export async function verifyTurnBoxIdentity(
	publicKeyBase64: string,
	value: string | null | undefined,
	now = Date.now(),
): Promise<TurnBoxIdentity | null> {
	const parsed = identityPayload.safeParse(
		await open(publicKeyBase64, IDENTITY_PREFIX, value),
	);
	if (!parsed.success || parsed.data.e <= now) return null;
	return {
		boxId: parsed.data.b,
		expiresAt: parsed.data.e,
		nonce: parsed.data.n,
	};
}

/**
 * Remembers single-use nonces (claim and grant replacement) until they
 * expire, so a captured request cannot be played again within one isolate.
 * Best effort by design: isolates do not share memory, so the fence that
 * always holds is the lease predicate on every write.
 */
export class TurnBoxReplayGuard {
	private readonly seen = new Map<string, number>();
	constructor(private readonly limit = 10_000) {}

	/** True the first time `nonce` is presented before `expiresAt`; false after. */
	consume(nonce: string, expiresAt: number, now = Date.now()) {
		for (const [key, until] of this.seen)
			if (until <= now) this.seen.delete(key);
		if (this.seen.has(nonce)) return false;
		if (this.seen.size >= this.limit) {
			// Refuse rather than forget: a full guard must not reopen replays.
			return false;
		}
		this.seen.set(nonce, expiresAt);
		return true;
	}
}

/** The bearer value of an Authorization header, if any. */
export function presentedTurnBoxToken(headers: Headers) {
	return (
		/^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1] ?? null
	);
}
