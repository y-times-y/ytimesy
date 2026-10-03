const encoder = new TextEncoder();
const SIGNATURE_HEADER = "x-ytimesy-delivery-signature";
const EXPIRY_HEADER = "x-ytimesy-delivery-expires";

async function signingKey(secret: string) {
	if (secret.length < 32)
		throw new Error("Delivery signing key must have at least 32 characters.");
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}
async function signedBytes(
	method: string,
	url: string,
	expires: string,
	body: string,
) {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
	const hash = Array.from(new Uint8Array(digest), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
	const target = new URL(url);
	return encoder.encode(
		`${method}\n${target.pathname}${target.search}\n${expires}\n${hash}`,
	);
}
export async function signDeliveryRequest(
	secret: string,
	method: string,
	url: string,
	body = "",
) {
	const expires = String(Date.now() + 60_000);
	const bytes = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			await signingKey(secret),
			await signedBytes(method, url, expires, body),
		),
	);
	return {
		[EXPIRY_HEADER]: expires,
		[SIGNATURE_HEADER]: Array.from(bytes, (value) =>
			value.toString(16).padStart(2, "0"),
		).join(""),
	};
}
export async function verifyDeliveryRequest(
	secret: string,
	request: Request,
	body: string,
) {
	const expires = request.headers.get(EXPIRY_HEADER) ?? "";
	const signature = request.headers.get(SIGNATURE_HEADER) ?? "";
	if (
		!/^\d{13}$/.test(expires) ||
		Number(expires) <= Date.now() ||
		Number(expires) > Date.now() + 65_000 ||
		!/^[0-9a-f]{64}$/.test(signature)
	)
		return false;
	const bytes = Uint8Array.from(signature.match(/../g) ?? [], (byte) =>
		Number.parseInt(byte, 16),
	);
	return crypto.subtle.verify(
		"HMAC",
		await signingKey(secret),
		bytes,
		await signedBytes(request.method, request.url, expires, body),
	);
}
