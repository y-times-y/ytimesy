import { createHmac, timingSafeEqual } from "node:crypto";
import { vmEdgeKey } from "./vm-edge-keys";

/**
 * Freestyle forward auth for preview routes: before the edge forwards a
 * request to a VM it asks this app, sending the caller's Cookie header plus
 * the static header below. A 2xx lets the request through; anything else goes
 * back to the browser and the VM is never contacted (nor woken).
 */
export const EDGE_AUTHORIZER_HEADER = "x-ytimesy-edge-key";
export const PREVIEW_COOKIE = "__Host-ytimesy-preview";
export const PREVIEW_LOGIN_PATH = "/__ytimesy/preview";
const LOGIN_GRANT_SECONDS = 120;
const SESSION_GRANT_SECONDS = 8 * 60 * 60;

type GrantPurpose = "login" | "session";
type PreviewGrant = {
	/** The TLS rule (one VM port) this grant opens; Freestyle names it per request. */
	readonly rule: string;
	readonly purpose: GrantPurpose;
	readonly expires: number;
};

export function edgeAuthorizerKey() {
	return vmEdgeKey("edge-authorizer", "freestyle");
}

/** Versioned by the key, so rotating the root makes a new Freestyle config rather than a stale one. */
export function edgeAuthorizerUrl(appUrl: string) {
	const url = new URL("/api/vm-edge/authorize", appUrl);
	if (url.protocol !== "https:")
		throw new Error("Preview links need the app to be served over HTTPS.");
	url.searchParams.set(
		"v",
		vmEdgeKey("edge-authorizer-url", "v1").slice(0, 12),
	);
	return url.href;
}

function sign(payload: string) {
	return createHmac("sha256", vmEdgeKey("preview-grant", "v1"))
		.update(payload)
		.digest("base64url");
}

function grantToken(grant: PreviewGrant) {
	const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
	return `${payload}.${sign(payload)}`;
}

function verifiedGrant(
	token: string | null | undefined,
	rule: string,
	purpose: GrantPurpose,
	now: number,
) {
	const [payload, signature, extra] = (token ?? "").split(".");
	if (!payload || !signature || extra !== undefined) return false;
	const expected = Buffer.from(sign(payload));
	const presented = Buffer.from(signature);
	if (
		expected.length !== presented.length ||
		!timingSafeEqual(expected, presented)
	)
		return false;
	try {
		const grant = JSON.parse(
			Buffer.from(payload, "base64url").toString(),
		) as PreviewGrant;
		return (
			grant.rule === rule && grant.purpose === purpose && grant.expires > now
		);
	} catch {
		return false;
	}
}

/** A two-minute link that signs the browser in to one preview route. */
export function previewLoginUrl(
	origin: string,
	ruleId: string,
	now = Date.now(),
) {
	const url = new URL(PREVIEW_LOGIN_PATH, origin);
	url.searchParams.set(
		"t",
		grantToken({
			rule: ruleId,
			purpose: "login",
			expires: now + LOGIN_GRANT_SECONDS * 1000,
		}),
	);
	return url.href;
}

function cookieValue(header: string | null, name: string) {
	for (const part of (header ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return null;
}

function keyMatches(presented: string | null) {
	const expected = Buffer.from(edgeAuthorizerKey());
	const given = Buffer.from(presented ?? "");
	return expected.length === given.length && timingSafeEqual(expected, given);
}

const privatePreview = () =>
	new Response(
		"<!doctype html><title>Private preview</title><p>This preview is private. Open it from ytimesy.</p>",
		{
			status: 401,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		},
	);

/** Answers one Freestyle forward-auth subrequest for a preview route. */
export function authorizePreviewRequest(request: Request, now = Date.now()) {
	if (!keyMatches(request.headers.get(EDGE_AUTHORIZER_HEADER)))
		return new Response(null, { status: 403 });
	const rule = request.headers.get("x-freestyle-tls-rule-id");
	if (!rule) return new Response(null, { status: 403 });
	const target = new URL(
		request.headers.get("x-forwarded-uri") ?? "/",
		"https://preview.invalid",
	);
	if (target.pathname === PREVIEW_LOGIN_PATH) {
		if (!verifiedGrant(target.searchParams.get("t"), rule, "login", now))
			return privatePreview();
		const session = grantToken({
			rule,
			purpose: "session",
			expires: now + SESSION_GRANT_SECONDS * 1000,
		});
		return new Response(null, {
			status: 303,
			headers: {
				location: "/",
				"cache-control": "no-store",
				"set-cookie": `${PREVIEW_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_GRANT_SECONDS}`,
			},
		});
	}
	return verifiedGrant(
		cookieValue(request.headers.get("cookie"), PREVIEW_COOKIE),
		rule,
		"session",
		now,
	)
		? new Response(null, { status: 204 })
		: privatePreview();
}
