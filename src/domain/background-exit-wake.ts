import { z } from "zod";

/**
 * A background command's exit callback. The guest posts this to the edge
 * executor (over the git proxy's origin, which every VM egress mode allows)
 * right after the command's status is written, so its chat is woken within
 * seconds instead of at the next minute's cron. The token is a capability for
 * one command of one chat: it only asks the edge to check that chat's
 * background commands now, which the claim on the machine makes idempotent.
 */
export const BACKGROUND_EXIT_PATH = "/background-exit";
export const BACKGROUND_EXIT_TOKEN_HEADER = "x-ytimesy-background-exit";

export const backgroundExitRequest = z
	.object({
		userId: z.string().min(1).max(128),
		sessionId: z.uuid(),
		commandId: z.uuid(),
	})
	.strict();
export type BackgroundExitRequest = z.infer<typeof backgroundExitRequest>;

const encoder = new TextEncoder();

async function key(secret: string) {
	if (secret.length < 32)
		throw new Error("Background exit signing key is too short.");
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/** Domain-separated from the git proxy's grants, which share the secret. */
const message = (request: BackgroundExitRequest) =>
	encoder.encode(
		`ytimesy:background-exit:v1\n${request.userId}\n${request.sessionId}\n${request.commandId}`,
	);

export async function backgroundExitToken(
	secret: string,
	request: BackgroundExitRequest,
) {
	const bytes = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			await key(secret),
			message(backgroundExitRequest.parse(request)),
		),
	);
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
		"",
	);
}

export async function verifyBackgroundExitToken(
	secret: string,
	request: BackgroundExitRequest,
	token: string,
) {
	if (!/^[0-9a-f]{64}$/.test(token)) return false;
	const bytes = Uint8Array.from(token.match(/../g) ?? [], (byte) =>
		Number.parseInt(byte, 16),
	);
	return crypto.subtle.verify(
		"HMAC",
		await key(secret),
		bytes,
		message(request),
	);
}
