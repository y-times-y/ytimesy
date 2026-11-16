/**
 * The Ed25519 private keys the Workers sign with (base64 PKCS8 DER, made by
 * scripts/generate-claude-runner-keypair.ts or
 * scripts/generate-codex-tunnel-keypair.ts). Only the Workers hold them; the
 * AWS boxes that check the signatures hold only the public keys.
 */
const imported = new Map<string, Promise<CryptoKey>>();

/** The imported key, once per isolate per value; `setting` names it in the error. */
export function ed25519SigningKey(pkcs8Base64: string, setting: string) {
	let key = imported.get(pkcs8Base64);
	if (!key) {
		key = crypto.subtle
			.importKey(
				"pkcs8",
				Uint8Array.from(atob(pkcs8Base64), (char) => char.charCodeAt(0)),
				{ name: "Ed25519" },
				false,
				["sign"],
			)
			.catch((error: unknown) => {
				imported.delete(pkcs8Base64);
				throw new Error(
					`${setting} is not a base64 PKCS8 Ed25519 private key.`,
					{ cause: error },
				);
			});
		imported.set(pkcs8Base64, key);
	}
	return key;
}
