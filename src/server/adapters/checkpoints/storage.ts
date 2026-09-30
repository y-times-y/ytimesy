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
