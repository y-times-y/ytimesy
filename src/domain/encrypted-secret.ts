import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRET_MASTER_KEY_BYTES = 32;

export type EncryptedSecret = {
	readonly version: 1;
	readonly iv: string;
	readonly tag: string;
	readonly ciphertext: string;
};

export function secretHint(secret: string): string {
	const trimmed = secret.trim();
	if (trimmed.length < 4) return "••••";
	return `••••${trimmed.slice(-4)}`;
}

export function encryptSecret(
	masterKey: Uint8Array,
	plaintext: string,
): EncryptedSecret {
	if (masterKey.byteLength !== SECRET_MASTER_KEY_BYTES) {
		throw new Error("Secret master key must be 32 bytes");
	}
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	return {
		version: 1,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}

export function decryptSecret(
	masterKey: Uint8Array,
	secret: EncryptedSecret,
): string {
	if (masterKey.byteLength !== SECRET_MASTER_KEY_BYTES) {
		throw new Error("Secret master key must be 32 bytes");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		masterKey,
		Buffer.from(secret.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(secret.ciphertext, "base64")),
		decipher.final(),
	]).toString("utf8");
}
