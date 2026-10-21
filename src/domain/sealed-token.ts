import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from "node:crypto";

/**
 * Versioned token-vault format: `v2.<kid>.<iv>.<ciphertext>.<tag>` (base64url),
 * AES-256-GCM with a per-kid key derived by HKDF and the purpose + userId bound
 * as associated data, so a blob copied to another row, user or purpose fails to
 * open. Anything without the `v2.` prefix is a legacy better-auth blob.
 */
export type SealBinding = { purpose: string; userId?: string | null };

export type VaultKeys = {
	/** Key id used for new writes. */
	current: string;
	/** Key material by id (any length; HKDF stretches it). */
	secrets: Record<string, string>;
};

const PREFIX = "v2.";

export function isVersionedSeal(value: string) {
	return value.startsWith(PREFIX);
}

function deriveKey(secret: string, kid: string) {
	return Buffer.from(
		hkdfSync("sha256", secret, "ytimesy-token-vault", `kid:${kid}`, 32),
	);
}

function associatedData(kid: string, binding?: SealBinding) {
	const purpose = binding?.purpose ?? "";
	const userId = binding?.userId ?? "";
	if (/[\n]/.test(purpose) || /[\n]/.test(userId))
		throw new Error("Invalid seal binding.");
	return Buffer.from(
		`ytimesy-vault\nv2\n${kid}\n${purpose}\n${userId}`,
		"utf8",
	);
}

export function sealVersioned(
	keys: VaultKeys,
	plaintext: string,
	binding?: SealBinding,
) {
	const secret = keys.secrets[keys.current];
	if (!secret) throw new Error("Token vault key is not configured.");
	if (!/^[a-z0-9]+$/.test(keys.current)) throw new Error("Invalid key id.");
	const iv = randomBytes(12);
	const cipher = createCipheriv(
		"aes-256-gcm",
		deriveKey(secret, keys.current),
		iv,
	);
	cipher.setAAD(associatedData(keys.current, binding));
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	return [
		"v2",
		keys.current,
		iv.toString("base64url"),
		ciphertext.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
	].join(".");
}

export function openVersioned(
	keys: VaultKeys,
	sealed: string,
	binding?: SealBinding,
) {
	const parts = sealed.split(".");
	if (parts.length !== 5 || parts[0] !== "v2")
		throw new Error("Malformed sealed value.");
	const [, kid, iv, ciphertext, tag] = parts;
	const secret = keys.secrets[kid];
	if (!secret) throw new Error(`Token vault key "${kid}" is not configured.`);
	const decipher = createDecipheriv(
		"aes-256-gcm",
		deriveKey(secret, kid),
		Buffer.from(iv, "base64url"),
	);
	decipher.setAAD(associatedData(kid, binding));
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertext, "base64url")),
		decipher.final(),
	]).toString("utf8");
}

/**
 * Key ring from env: TOKEN_VAULT_KEY (kid "k1") when set, otherwise
 * BETTER_AUTH_SECRET (kid "k0"). k0 stays readable after TOKEN_VAULT_KEY is
 * introduced so earlier v2 blobs keep opening.
 */
export function vaultKeys(env: {
	BETTER_AUTH_SECRET: string;
	TOKEN_VAULT_KEY?: string;
}): VaultKeys {
	const secrets: Record<string, string> = { k0: env.BETTER_AUTH_SECRET };
	if (env.TOKEN_VAULT_KEY) secrets.k1 = env.TOKEN_VAULT_KEY;
	return { current: env.TOKEN_VAULT_KEY ? "k1" : "k0", secrets };
}
