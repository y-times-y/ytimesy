import { z } from "zod";

/**
 * A Claude Code turn's capability: what the VM holds instead of the user's
 * subscription token. Claude Code sends CLAUDE_CODE_OAUTH_TOKEN verbatim as
 * its bearer, so the placeholder token IS this signed grant; the edge proxy
 * verifies it, checks the turn is still running and only then swaps in the
 * real token. It names one user, chat and turn; it is useless for anything
 * but that turn's model requests and its ytimesy MCP tools.
 *
 * Format: `ytcc1.<base64url payload>.<base64url HMAC-SHA256>`, keyed by a
 * key derived from the edge's git-proxy secret for this purpose only.
 */
const PREFIX = "ytcc1";
const MAX_LENGTH = 1024;
/** A grant outlives no turn: the proxy also refuses once the turn ended. */
export const CLAUDE_CODE_GRANT_TTL_MS = 6 * 60 * 60 * 1000;

const payloadSchema = z
	.object({
		u: z.string().min(1).max(128),
		s: z.uuid(),
		t: z.uuid(),
		e: z.number().int().positive(),
		n: z.string().regex(/^[a-f0-9]{16}$/),
	})
	.strict();

export type ClaudeCodeGrant = {
	readonly userId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly expiresAt: number;
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

function fromBase64url(text: string) {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
	const padded = text.replaceAll("-", "+").replaceAll("_", "/");
	try {
		return Uint8Array.from(
			atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
			(character) => character.charCodeAt(0),
		);
	} catch {
		return null;
	}
}

async function grantKey(secret: string) {
	if (secret.length < 32)
		throw new Error("Claude Code grant key must have at least 32 characters.");
	const root = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const derived = await crypto.subtle.sign(
		"HMAC",
		root,
		encoder.encode("ytimesy:claude-code-grant:v1"),
	);
	return crypto.subtle.importKey(
		"raw",
		derived,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function issueClaudeCodeGrant(
	secret: string,
	input: Omit<ClaudeCodeGrant, "expiresAt"> & { readonly expiresAt?: number },
	now = Date.now(),
) {
	const payload = payloadSchema.parse({
		u: input.userId,
		s: input.sessionId,
		t: input.turnId,
		e: input.expiresAt ?? now + CLAUDE_CODE_GRANT_TTL_MS,
		n: Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) =>
			value.toString(16).padStart(2, "0"),
		).join(""),
	});
	const body = base64url(encoder.encode(JSON.stringify(payload)));
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			await grantKey(secret),
			encoder.encode(`${PREFIX}.${body}`),
		),
	);
	return `${PREFIX}.${body}.${base64url(signature)}`;
}

/** The grant a bearer value carries, or null when it is malformed, forged or expired. */
export async function verifyClaudeCodeGrant(
	secret: string,
	value: string | null | undefined,
	now = Date.now(),
): Promise<ClaudeCodeGrant | null> {
	if (!value || value.length > MAX_LENGTH) return null;
	const parts = value.split(".");
	if (parts.length !== 3 || parts[0] !== PREFIX) return null;
	const [, body, signature] = parts as [string, string, string];
	const signatureBytes = fromBase64url(signature);
	const bodyBytes = fromBase64url(body);
	if (signatureBytes?.byteLength !== 32 || !bodyBytes) return null;
	const valid = await crypto.subtle.verify(
		"HMAC",
		await grantKey(secret),
		signatureBytes,
		encoder.encode(`${PREFIX}.${body}`),
	);
	if (!valid) return null;
	let parsed: z.infer<typeof payloadSchema>;
	try {
		parsed = payloadSchema.parse(
			JSON.parse(new TextDecoder().decode(bodyBytes)),
		);
	} catch {
		return null;
	}
	if (parsed.e <= now) return null;
	return {
		userId: parsed.u,
		sessionId: parsed.s,
		turnId: parsed.t,
		expiresAt: parsed.e,
	};
}

/** The bearer value of an Authorization header (or x-api-key), if any. */
export function presentedClaudeCodeGrant(headers: Headers) {
	const authorization = headers.get("authorization") ?? "";
	const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
	return bearer ?? headers.get("x-api-key") ?? null;
}
