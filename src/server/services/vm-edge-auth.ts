import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type PreviewGrantStore,
	previewGrants,
} from "../adapters/preview-grants";
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

type GrantBase = {
	/** The TLS rule (one VM port) this grant opens; Freestyle names it per request. */
	readonly rule: string;
	/** The ytimesy user the grant was issued to. */
	readonly user: string;
	readonly expires: number;
};
/** A sign-in link: its nonce is recorded server side and usable once. */
type LoginGrant = GrantBase & {
	readonly purpose: "login";
	readonly nonce: string;
};
/** The cookie: valid only while the route's grant version is still `version`. */
type SessionGrant = GrantBase & {
	readonly purpose: "session";
	readonly version: number;
};
type PreviewGrant = LoginGrant | SessionGrant;

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

function verifiedGrant<P extends PreviewGrant["purpose"]>(
	token: string | null | undefined,
	rule: string,
	purpose: P,
	now: number,
): Extract<PreviewGrant, { purpose: P }> | null {
	const [payload, signature, extra] = (token ?? "").split(".");
	if (!payload || !signature || extra !== undefined) return null;
	const expected = Buffer.from(sign(payload));
	const presented = Buffer.from(signature);
	if (
		expected.length !== presented.length ||
		!timingSafeEqual(expected, presented)
	)
		return null;
	try {
		const grant = JSON.parse(
			Buffer.from(payload, "base64url").toString(),
		) as PreviewGrant;
		return grant.rule === rule &&
			grant.purpose === purpose &&
			typeof grant.user === "string" &&
			grant.user.length > 0 &&
			grant.expires > now
			? (grant as Extract<PreviewGrant, { purpose: P }>)
			: null;
	} catch {
		return null;
	}
}

/**
 * A two-minute, single-use link that signs the browser in to one preview
 * route. Binds the route to this user's chat first, so deleting the chat,
 * project or account (or withdrawing access) invalidates its cookies.
 */
export async function previewLoginUrl(
	origin: string,
	scope: {
		ruleId: string;
		userId: string;
		projectId: string;
		sessionId: string;
	},
	store: PreviewGrantStore = previewGrants,
	now = Date.now(),
) {
	await store.grant(scope);
	const nonce = randomBytes(24).toString("base64url");
	const expires = now + LOGIN_GRANT_SECONDS * 1000;
	await store.recordNonce({
		nonce,
		ruleId: scope.ruleId,
		userId: scope.userId,
		expiresAt: new Date(expires),
	});
	const url = new URL(PREVIEW_LOGIN_PATH, origin);
	url.searchParams.set(
		"t",
		grantToken({
			rule: scope.ruleId,
			user: scope.userId,
			purpose: "login",
			nonce,
			expires,
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
export async function authorizePreviewRequest(
	request: Request,
	now = Date.now(),
	store: PreviewGrantStore = previewGrants,
) {
	if (!keyMatches(request.headers.get(EDGE_AUTHORIZER_HEADER)))
		return new Response(null, { status: 403 });
	const rule = request.headers.get("x-freestyle-tls-rule-id");
	if (!rule) return new Response(null, { status: 403 });
	const target = new URL(
		request.headers.get("x-forwarded-uri") ?? "/",
		"https://preview.invalid",
	);
	if (target.pathname === PREVIEW_LOGIN_PATH) {
		const login = verifiedGrant(
			target.searchParams.get("t"),
			rule,
			"login",
			now,
		);
		if (!login || typeof login.nonce !== "string") return privatePreview();
		const version = await store.consumeNonce({
			nonce: login.nonce,
			ruleId: rule,
			userId: login.user,
		});
		if (version === null) return privatePreview();
		const session = grantToken({
			rule,
			user: login.user,
			purpose: "session",
			version,
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
	const session = verifiedGrant(
		cookieValue(request.headers.get("cookie"), PREVIEW_COOKIE),
		rule,
		"session",
		now,
	);
	if (!session || typeof session.version !== "number") return privatePreview();
	return (await store.version(rule, session.user)) === session.version
		? new Response(null, { status: 204 })
		: privatePreview();
}
