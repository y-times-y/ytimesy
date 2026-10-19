import { createHash } from "node:crypto";
import { evidenceFileName } from "#/domain/pr-evidence";
import {
	r2Configuration,
	r2DeletePrefix,
	r2GetObject,
	r2PutObject,
} from "./checkpoints/r2";

/**
 * Pull request evidence media in the private R2 checkpoint bucket, under
 * `pr-evidence/<sha256(user)>/<sha256(project)>/<evidence id>/<file>`. The
 * bucket has no public domain; files are only read back by the signed-in
 * media route after it checked the project's owner.
 */
const ROOT = "pr-evidence";

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function evidenceUserPrefix(userId: string) {
	if (!userId) throw new Error("Invalid evidence owner.");
	return `${ROOT}/${digest(userId)}/`;
}

export function evidenceProjectPrefix(userId: string, projectId: string) {
	if (!UUID.test(projectId)) throw new Error("Invalid evidence project.");
	return `${evidenceUserPrefix(userId)}${digest(projectId)}/`;
}

export function evidenceCapturePrefix(
	scope: { userId: string; projectId: string },
	evidenceId: string,
) {
	if (!UUID.test(evidenceId)) throw new Error("Invalid evidence id.");
	return `${evidenceProjectPrefix(scope.userId, scope.projectId)}${evidenceId}/`;
}

export function evidenceObjectKey(
	scope: { userId: string; projectId: string },
	evidenceId: string,
	name: string,
) {
	if (!evidenceFileName(name)) throw new Error("Invalid evidence file.");
	return `${evidenceCapturePrefix(scope, evidenceId)}${name}`;
}

/** Whether media can be stored at all (R2 configured). */
export function evidenceStoreConfigured() {
	try {
		return Boolean(r2Configuration());
	} catch {
		return false;
	}
}

function config() {
	const value = r2Configuration();
	if (!value) throw new Error("Evidence storage is not configured.");
	return value;
}

export type EvidenceStore = {
	put(key: string, body: Uint8Array, contentType: string): Promise<void>;
	/** The object (status 200/206/416/404), with an optional byte range. */
	get(key: string, range?: string | null): Promise<Response>;
	/** Removes every object under a prefix this module built. */
	removePrefix(prefix: string): Promise<number>;
};

export const r2EvidenceStore: EvidenceStore = {
	put: (key, body, contentType) =>
		r2PutObject(config(), key, body, contentType),
	get: (key, range) => r2GetObject(config(), key, range),
	removePrefix: async (prefix) => {
		if (!prefix.startsWith(`${ROOT}/`))
			throw new Error("Refusing to delete outside pull request evidence.");
		// Without storage there is nothing stored to delete.
		const value = r2Configuration();
		return value ? r2DeletePrefix(value, prefix) : 0;
	},
};
