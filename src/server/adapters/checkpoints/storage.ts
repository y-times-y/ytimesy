import { createHash } from "node:crypto";
import { seal, unseal } from "#/server/auth/token-vault";

const BUCKET = "ytimesy-checkpoints";
const MAX_BYTES = 48 * 1024 * 1024;

function configuration() {
	const url = process.env.SUPABASE_STORAGE_URL;
	const key = process.env.SUPABASE_STORAGE_SERVICE_KEY;
	if (!url || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) || !key)
		throw new Error("Private checkpoint storage is not configured.");
	return { url, key };
}

async function request(path: string, options: RequestInit = {}) {
	const { url, key } = configuration();
	return fetch(`${url}/storage/v1/${path}`, {
		...options,
		redirect: "error",
		signal: AbortSignal.timeout(60_000),
		headers: {
			apikey: key,
			Authorization: `Bearer ${key}`,
			...options.headers,
		},
	});
}

export async function ensurePrivateCheckpointBucket() {
	const found = await request(`bucket/${BUCKET}`);
	if (found.ok) {
		const bucket = await found.json();
		if (bucket.public !== false)
			throw new Error("Checkpoint bucket must be private.");
		return;
	}
	if (found.status !== 404 && found.status !== 400)
		throw new Error("Cannot inspect private checkpoint storage.");
	const created = await request("bucket", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: BUCKET,
			name: BUCKET,
			public: false,
			file_size_limit: MAX_BYTES,
		}),
	});
	if (!created.ok) throw new Error("Cannot create private checkpoint storage.");
}

export function checkpointObjectPrefix(userId: string, sessionId: string) {
	return `${createHash("sha256").update(userId).digest("hex")}/${createHash("sha256").update(sessionId).digest("hex")}/`;
}

export async function uploadCheckpoint(
	userId: string,
	sessionId: string,
	revision: string,
	payload: string,
) {
	if (Buffer.byteLength(payload) > 20 * 1024 * 1024)
		throw new Error("Checkpoint exceeds the 20 MiB payload safety limit.");
	if (!/^[a-zA-Z0-9-]+$/.test(revision))
		throw new Error("Invalid checkpoint revision.");
	const path = `${checkpointObjectPrefix(userId, sessionId)}${revision}.enc`;
	const ciphertext = await seal(JSON.stringify({ userId, sessionId, payload }));
	const result = await request(`object/${BUCKET}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: ciphertext,
	});
	if (!result.ok)
		throw new Error(
			"Checkpoint upload failed; the last saved checkpoint was retained.",
		);
	return path;
}

export async function downloadCheckpoint(
	userId: string,
	sessionId: string,
	path: string,
) {
	if (
		!path.startsWith(checkpointObjectPrefix(userId, sessionId)) ||
		path.includes("..")
	)
		throw new Error("Checkpoint ownership mismatch.");
	const result = await request(`object/${BUCKET}/${path}`);
	if (!result.ok) throw new Error("The saved checkpoint is unavailable.");
	const encrypted = await result.text();
	if (Buffer.byteLength(encrypted) > MAX_BYTES)
		throw new Error("Checkpoint is too large.");
	const envelope = JSON.parse(await unseal(encrypted));
	if (
		envelope.userId !== userId ||
		envelope.sessionId !== sessionId ||
		typeof envelope.payload !== "string"
	)
		throw new Error("Checkpoint ownership mismatch.");
	return envelope.payload as string;
}

export async function removeCheckpoint(path: string) {
	const result = await request(`object/${BUCKET}`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prefixes: [path] }),
	});
	if (!result.ok) throw new Error("Could not remove the private checkpoint.");
}

/** Listing is scoped by the trusted caller, never by a model-supplied object path. */
export async function listContextArchives(
	userId: string,
	sessionId: string,
	offset = 0,
	limit = 3,
) {
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 10
	)
		throw new Error("Invalid archive page.");
	const result = await request(`object/list/${BUCKET}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			prefix: checkpointObjectPrefix(userId, sessionId),
			search: "context-",
			offset,
			limit,
			sortBy: { column: "name", order: "asc" },
		}),
	});
	if (!result.ok)
		throw new Error("Could not list this chat's context archives.");
	const rows: unknown = await result.json();
	if (!Array.isArray(rows)) throw new Error("Invalid context archive listing.");
	return rows.map((row) => {
		if (
			typeof row?.name !== "string" ||
			!/^context-[0-9a-f-]{36}\.enc$/.test(row.name)
		)
			throw new Error("Invalid context archive name.");
		return row.name.slice(0, -4) as string;
	});
}

/** Delete only archived context objects beneath the already-authorized chat scope. */
export async function removeContextArchives(userId: string, sessionId: string) {
	const prefix = checkpointObjectPrefix(userId, sessionId);
	for (let batch = 0; batch < 100; batch++) {
		const result = await request(`object/list/${BUCKET}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prefix,
				search: "context-",
				limit: 100,
				offset: 0,
			}),
		});
		if (!result.ok)
			throw new Error("Could not list context archives for deletion.");
		const rows: unknown = await result.json();
		if (!Array.isArray(rows))
			throw new Error("Invalid context archive listing.");
		if (!rows.length) return;
		const paths = rows.map((row) => {
			if (
				typeof row.name !== "string" ||
				!/^context-[0-9a-f-]{36}\.enc$/.test(row.name)
			)
				throw new Error("Unexpected context archive name; deletion stopped.");
			return `${prefix}${row.name}`;
		});
		const removed = await request(`object/${BUCKET}`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prefixes: paths }),
		});
		if (!removed.ok) throw new Error("Could not delete context archives.");
	}
	throw new Error(
		"Context archive deletion exceeded its bounded batch limit; retry chat deletion.",
	);
}
