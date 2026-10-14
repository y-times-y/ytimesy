import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { seal, unseal } from "#/server/auth/token-vault";
import { r2Configuration, r2Request } from "./r2";

const BUCKET = "ytimesy-checkpoints";
const MAX_BYTES = 48 * 1024 * 1024;

/** Whether any private checkpoint backend (evaluation disk, R2 or Supabase) is set up. */
export function checkpointStorageConfigured() {
	return Boolean(
		evaluationCheckpointDirectory() ||
			r2Configuration() ||
			process.env.SUPABASE_STORAGE_SERVICE_KEY,
	);
}

function configuration() {
	const url = process.env.SUPABASE_STORAGE_URL;
	const key = process.env.SUPABASE_STORAGE_SERVICE_KEY;
	if (!url || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) || !key)
		throw new Error("Private checkpoint storage is not configured.");
	return { url, key };
}

/** Isolated evaluations keep their encrypted checkpoints on local disk, never in shared storage. */
function evaluationCheckpointDirectory() {
	const directory = process.env.YTIMESY_EVALUATION_CHECKPOINT_DIR;
	return directory && process.env.YTIMESY_HARNESS_EVALUATION_ENABLED === "1"
		? resolve(directory)
		: null;
}

/** Emulates the five storage calls below against files, so callers are unchanged. */
async function localRequest(
	directory: string,
	path: string,
	options: RequestInit,
): Promise<Response> {
	const method = options.method ?? "GET";
	const json = (value: unknown) => new Response(JSON.stringify(value));
	const object = (name: string) => {
		const target = resolve(directory, name);
		if (!target.startsWith(`${directory}${sep}`))
			throw new Error("Checkpoint path escaped local evaluation storage.");
		return target;
	};
	if (path.startsWith("bucket")) return json({ public: false });
	const body = () => JSON.parse(String(options.body ?? "{}"));
	if (path === `object/list/${BUCKET}`) {
		const { prefix, search = "", offset = 0, limit = 100 } = body();
		const names = await readdir(object(prefix)).catch(() => [] as string[]);
		return json(
			names
				.filter((name) => name.startsWith(search))
				.sort()
				.slice(offset, offset + limit)
				.map((name) => ({ name })),
		);
	}
	if (path === `object/${BUCKET}` && method === "DELETE") {
		for (const prefix of body().prefixes as string[])
			await rm(object(prefix), { force: true });
		return json({});
	}
	const name = path.slice(`object/${BUCKET}/`.length);
	if (method === "POST") {
		await mkdir(dirname(object(name)), { recursive: true, mode: 0o700 });
		await writeFile(object(name), String(options.body), { mode: 0o600 });
		return json({});
	}
	try {
		return new Response(await readFile(object(name), "utf8"));
	} catch {
		return new Response("not found", { status: 404 });
	}
}

async function request(path: string, options: RequestInit = {}) {
	const local = evaluationCheckpointDirectory();
	if (local) return localRequest(local, path, options);
	// R2 replaces Supabase Storage when configured: same object paths, no egress fees.
	const r2 = r2Configuration();
	if (r2) return r2Request(r2, BUCKET, path, options);
	const { url, key } = configuration();
	return fetch(`${url}/storage/v1/${path}`, {
		...options,
		redirect: "manual",
		signal: AbortSignal.timeout(60_000),
		headers: {
			apikey: key,
			Authorization: `Bearer ${key}`,
			...options.headers,
		},
	});
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

function attachmentObjectPath(userId: string, sessionId: string, id: string) {
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid attachment id.");
	return `attachments/${checkpointObjectPrefix(userId, sessionId)}${id}.enc`;
}

/** Sealed like checkpoints: the envelope binds the bytes to their owner and chat. */
export async function uploadMessageAttachment(
	userId: string,
	sessionId: string,
	id: string,
	base64: string,
) {
	const path = attachmentObjectPath(userId, sessionId, id);
	const ciphertext = await seal(
		JSON.stringify({ userId, sessionId, id, base64 }),
	);
	const result = await request(`object/${BUCKET}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: ciphertext,
	});
	if (!result.ok) throw new Error("Could not save the attached file.");
}

export async function downloadMessageAttachment(
	userId: string,
	sessionId: string,
	id: string,
) {
	const result = await request(
		`object/${BUCKET}/${attachmentObjectPath(userId, sessionId, id)}`,
	);
	if (!result.ok) throw new Error("An attached file is unavailable.");
	const encrypted = await result.text();
	if (Buffer.byteLength(encrypted) > MAX_BYTES)
		throw new Error("Attached file is too large.");
	const envelope = JSON.parse(await unseal(encrypted));
	if (
		envelope.userId !== userId ||
		envelope.sessionId !== sessionId ||
		envelope.id !== id ||
		typeof envelope.base64 !== "string"
	)
		throw new Error("Attachment ownership mismatch.");
	return envelope.base64 as string;
}
