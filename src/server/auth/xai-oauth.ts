import { z } from "zod";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";

/**
 * xAI's OAuth, as its announced partners (OpenCode, Kilo Code, Hermes) sign
 * in to a SuperGrok subscription: xAI's shared public client, the device
 * authorization grant (RFC 8628) at auth.x.ai, and a referrer naming the app.
 */
export const XAI_OAUTH_ISSUER = "https://auth.x.ai/oauth2";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE =
	"openid profile email offline_access grok-cli:access api:access";
export const XAI_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Lets xAI attribute sign-ins to ytimesy (OpenCode sends referrer=opencode). */
export const XAI_OAUTH_REFERRER = "ytimesy";

const REQUEST_TIMEOUT_MS = 15_000;

export const xaiTokenResponse = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).nullish(),
	expires_in: z.number().positive().nullish(),
});
export type XaiTokenResponse = z.infer<typeof xaiTokenResponse>;

/** A form POST to the issuer (`/device/code` or `/token`). */
export function postXaiOAuth(path: string, body: Record<string, string>) {
	return fetch(`${XAI_OAUTH_ISSUER}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
			"user-agent": "ytimesy",
		},
		body: new URLSearchParams(body).toString(),
		redirect: "manual",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

export async function xaiOAuthJson(response: Response): Promise<unknown> {
	return JSON.parse(await readBoundedRequestBody(response, 64 * 1024));
}

/**
 * When the access token expires (epoch ms): `expires_in` when xAI sends it,
 * else the JWT's `exp`, else an hour, as OpenCode reads it.
 */
export function xaiTokenExpiresAt(
	tokens: Pick<XaiTokenResponse, "access_token" | "expires_in">,
	now = Date.now(),
): number {
	if (tokens.expires_in) return now + tokens.expires_in * 1000;
	try {
		const claims = JSON.parse(
			Buffer.from(
				tokens.access_token.split(".")[1] ?? "",
				"base64url",
			).toString(),
		) as { exp?: unknown };
		if (typeof claims.exp === "number" && Number.isFinite(claims.exp))
			return claims.exp * 1000;
	} catch {
		// An opaque token: assume the usual lifetime and refresh on a 401.
	}
	return now + 3_600_000;
}
