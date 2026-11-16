import { Client } from "tunnelfetch";
import { ed25519SigningKey } from "./ed25519-signing-key";

/**
 * The proxy (scripts/codex-connect-proxy.py) admits one CONNECT to
 * chatgpt.com:443 per credential: proxy user `ytimesy`, password
 * `e1.<expires>.<nonce>.<Ed25519 signature, hex>` signed with
 * YTIMESY_CODEX_TUNNEL_SIGNING_KEY (base64 PKCS8; the proxy holds only the
 * public key), or, until that key is set, the legacy
 * `<expires>.<nonce>.<HMAC-SHA256, hex>` of YTIMESY_CODEX_TUNNEL_SECRET.
 * Each credential expires in 60 s and its nonce is accepted once.
 */
const TARGET = "chatgpt.com:443";
/** A base64 PKCS8 DER Ed25519 private key is 48 bytes: 64 base64 characters. */
const SIGNING_KEY = /^[A-Za-z0-9+/]{64}$/;
const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer | Uint8Array) =>
	Array.from(new Uint8Array(bytes), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");

/** The bytes an Ed25519 credential signs; keep in step with `authorize` in the proxy. */
export const codexTunnelEd25519Material = (expires: string, nonce: string) =>
	encoder.encode(`e1.${expires}.${nonce}.${TARGET}`);

/** The proxy password for one CONNECT: Ed25519 when its key is set, else the legacy HMAC. */
export async function codexTunnelCredential(
	env: Readonly<Record<string, string | undefined>>,
	now = Date.now(),
) {
	const expires = String(now + 60_000);
	const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
	const signingKey = (env.YTIMESY_CODEX_TUNNEL_SIGNING_KEY ?? "").trim();
	if (signingKey) {
		// A set but unusable key must not quietly fall back to the HMAC the
		// proxy may no longer accept.
		if (!SIGNING_KEY.test(signingKey))
			throw new Error(
				"YTIMESY_CODEX_TUNNEL_SIGNING_KEY is not a base64 PKCS8 Ed25519 private key.",
			);
		const signature = await crypto.subtle.sign(
			{ name: "Ed25519" },
			await ed25519SigningKey(signingKey, "YTIMESY_CODEX_TUNNEL_SIGNING_KEY"),
			codexTunnelEd25519Material(expires, nonce),
		);
		return `e1.${expires}.${nonce}.${hex(signature)}`;
	}
	const secret = env.YTIMESY_CODEX_TUNNEL_SECRET;
	if (!secret || secret.length < 64)
		throw new Error("Codex tunnel signing key is missing.");
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${expires}.${nonce}.${TARGET}`),
	);
	return `${expires}.${nonce}.${hex(signature)}`;
}

/** A request owns its TLS connection until its response is consumed or cancelled. */
export async function codexTunnelFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const target = new URL(input instanceof Request ? input.url : String(input));
	if (
		target.origin !== "https://chatgpt.com" ||
		!target.pathname.startsWith("/backend-api/")
	) {
		throw new Error("Codex tunnel destination is not allowed.");
	}
	const proxy = process.env.YTIMESY_CODEX_TUNNEL_URL;
	if (!proxy) throw new Error("Codex tunnel is not configured.");
	const proxyUrl = new URL(proxy);
	proxyUrl.username = "ytimesy";
	proxyUrl.password = await codexTunnelCredential(process.env);
	const { connect } = await import("cloudflare:sockets").catch(
		(cause: unknown) => {
			throw new Error(
				"The Codex TCP tunnel requires the Cloudflare Workers sockets runtime.",
				{ cause },
			);
		},
	);
	const client = new Client({
		connect: (address, options) => {
			const hostname = address.hostname;
			return connect(
				{
					...address,
					hostname:
						hostname.includes(":") && !hostname.startsWith("[")
							? `[${hostname}]`
							: hostname,
				},
				{
					secureTransport: options?.secureTransport ?? "off",
					allowHalfOpen: options?.allowHalfOpen ?? false,
				},
			);
		},
		proxy: proxyUrl.href,
		trust: { mode: "system" },
		timeouts: { idleMs: 0, totalMs: 0 },
	});
	try {
		const response = await client.fetch(input, { ...init, redirect: "manual" });
		if (!response.body) {
			await client.close();
			return response;
		}
		const reader = response.body.getReader();
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						await client.close();
					} else controller.enqueue(next.value);
				} catch (error) {
					controller.error(error);
					await client.close();
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					await client.close();
				}
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		await client.close();
		throw error;
	}
}
