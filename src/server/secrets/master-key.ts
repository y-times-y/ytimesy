import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SECRET_MASTER_KEY_BYTES } from "#/domain/encrypted-secret";

const MASTER_KEY_PATH = ".ytimesy/secrets.key";

export async function loadSecretMasterKey(): Promise<Uint8Array> {
	const fromEnv = process.env.YTIMESY_SECRETS_KEY?.trim();
	if (fromEnv) return decodeMasterKey(fromEnv);
	try {
		const stored = (await readFile(MASTER_KEY_PATH, "utf8")).trim();
		if (stored) return decodeMasterKey(stored);
	} catch {
		// First local run creates a key that stays out of git.
	}
	const generated = randomBytes(SECRET_MASTER_KEY_BYTES);
	await mkdir(".ytimesy", { recursive: true });
	await writeFile(MASTER_KEY_PATH, generated.toString("base64"), {
		mode: 0o600,
	});
	return generated;
}

function decodeMasterKey(value: string): Uint8Array {
	const asHex =
		value.length === SECRET_MASTER_KEY_BYTES * 2 && /^[0-9a-fA-F]+$/.test(value)
			? Buffer.from(value, "hex")
			: Buffer.from(value, "base64");
	if (asHex.byteLength !== SECRET_MASTER_KEY_BYTES) {
		throw new Error("YTIMESY_SECRETS_KEY must decode to 32 bytes");
	}
	return asHex;
}
