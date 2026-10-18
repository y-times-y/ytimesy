import { evidenceObjectKey } from "#/domain/pr-evidence";
import { r2Configuration, r2GetObject, r2PutObject } from "./checkpoints/r2";

/**
 * Pull request evidence lives in the private R2 checkpoint bucket under
 * `pr-evidence/<random id>/`, and is served read-only by the edge executor at
 * `<origin>/pr-evidence/<id>/<file>` so GitHub can render it. The id is 128
 * random bits; nothing else in the bucket is reachable through that route.
 */

/** Where the edge serves evidence (the public edge origin), or null when evidence cannot be shown. */
export function evidencePublicOrigin(
	env: {
		readonly YTIMESY_PR_EVIDENCE_URL?: string;
		readonly YTIMESY_GIT_PROXY_URL?: string;
	} = process.env,
) {
	const value = env.YTIMESY_PR_EVIDENCE_URL || env.YTIMESY_GIT_PROXY_URL;
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password
			? url.origin
			: null;
	} catch {
		return null;
	}
}

export function evidenceStoreConfigured() {
	try {
		return Boolean(r2Configuration());
	} catch {
		return false;
	}
}

export function evidenceFileUrl(origin: string, id: string, name: string) {
	// Validates id and name the same way storage does.
	evidenceObjectKey(id, name);
	return `${origin}/pr-evidence/${id}/${name}`;
}

export async function putEvidenceFile(
	id: string,
	name: string,
	body: Uint8Array,
	contentType: string,
) {
	const config = r2Configuration();
	if (!config) throw new Error("Evidence storage is not configured.");
	await r2PutObject(config, evidenceObjectKey(id, name), body, contentType);
}

/** Reads a stored file by its validated key; null when storage is not configured. */
export function getEvidenceFile(key: string, range?: string | null) {
	const config = r2Configuration();
	if (!config) return null;
	return r2GetObject(config, key, range);
}
