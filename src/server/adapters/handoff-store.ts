import { createHash } from "node:crypto";
import { sealBytes, unsealBytes } from "../auth/token-vault";
import {
	r2Configuration,
	r2DeletePrefix,
	r2GetObject,
	r2PutObject,
} from "./checkpoints/r2";

/**
 * Imported local sessions in the private R2 checkpoint bucket, sealed
 * (AES-256-GCM, bound to the user and the object):
 * `handoff/<sha256(user)>/<sha256(project)>/<imported session id>/{handoff.json,transcript.tgz}.sealed`.
 * Only the server reads them back, for the chat's machine.
 */
const ROOT = "handoff";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type HandoffObject = "handoff.json" | "transcript.tgz";

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

export function handoffUserPrefix(userId: string) {
	if (!userId) throw new Error("Invalid handoff owner.");
	return `${ROOT}/${digest(userId)}/`;
}

export function handoffProjectPrefix(userId: string, projectId: string) {
	if (!UUID.test(projectId)) throw new Error("Invalid handoff project.");
	return `${handoffUserPrefix(userId)}${digest(projectId)}/`;
}

export function handoffObjectKey(
	scope: { userId: string; projectId: string },
	importedSessionId: string,
	object: HandoffObject,
) {
	if (!UUID.test(importedSessionId))
		throw new Error("Invalid imported session.");
	return `${handoffProjectPrefix(scope.userId, scope.projectId)}${importedSessionId}/${object}.sealed`;
}

function binding(userId: string, importedSessionId: string, object: string) {
	return { purpose: `local-import:${importedSessionId}:${object}`, userId };
}

function config() {
	const value = r2Configuration();
	if (!value)
		throw new Error("Storage for imported sessions is not configured.");
	return value;
}

export async function storeHandoffObject(
	scope: { userId: string; projectId: string },
	importedSessionId: string,
	object: HandoffObject,
	bytes: Uint8Array,
) {
	const sealed = sealBytes(
		bytes,
		binding(scope.userId, importedSessionId, object),
	);
	await r2PutObject(
		config(),
		handoffObjectKey(scope, importedSessionId, object),
		sealed,
		"application/octet-stream",
	);
}

/** The object's bytes, or null when it was never stored. */
export async function readHandoffObject(
	scope: { userId: string; projectId: string },
	importedSessionId: string,
	object: HandoffObject,
): Promise<Uint8Array | null> {
	const response = await r2GetObject(
		config(),
		handoffObjectKey(scope, importedSessionId, object),
	);
	if (response.status === 404) return null;
	if (!response.ok)
		throw new Error(`Imported session storage failed (${response.status}).`);
	return unsealBytes(
		new Uint8Array(await response.arrayBuffer()),
		binding(scope.userId, importedSessionId, object),
	);
}

/** Removes a project's (or, without one, all of a user's) imported sessions. */
export async function removeHandoffObjects(userId: string, projectId?: string) {
	const value = r2Configuration();
	// Without storage there is nothing stored to delete.
	if (!value) return 0;
	return r2DeletePrefix(
		value,
		projectId
			? handoffProjectPrefix(userId, projectId)
			: handoffUserPrefix(userId),
	);
}
