import { createHash, createHmac } from "node:crypto";

/**
 * Cloudflare R2 through its S3-compatible API, signed with AWS Signature V4.
 * Only node:crypto is used, so the same code runs in Node and in Workers
 * with nodejs_compat.
 */
type R2Configuration = {
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
};

export function r2Configuration(): R2Configuration | null {
	const accountId = process.env.R2_ACCOUNT_ID;
	const accessKeyId = process.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
	const bucket = process.env.R2_CHECKPOINT_BUCKET;
	if (!accountId && !accessKeyId && !secretAccessKey && !bucket) return null;
	if (
		!accountId ||
		!/^[a-f0-9]{32}$/.test(accountId) ||
		!accessKeyId ||
		!secretAccessKey ||
		!bucket ||
		!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
	)
		throw new Error("Private R2 checkpoint storage is misconfigured.");
	return { accountId, accessKeyId, secretAccessKey, bucket };
}

const sha256 = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
	createHmac("sha256", key).update(data).digest();
const encode = (text: string) =>
	encodeURIComponent(text).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/** Signature V4 headers for one request; `now` is injectable for verification. */
export function signedR2Headers(input: {
	method: string;
	url: URL;
	body: string | Uint8Array;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
	now?: Date;
}) {
	const region = input.region ?? "auto";
	const stamp = (input.now ?? new Date())
		.toISOString()
		.replace(/[-:]|\.\d{3}/g, "");
	const day = stamp.slice(0, 8);
	const payload = sha256(input.body);
	const query = [...input.url.searchParams]
		.map(([key, value]) => `${encode(key)}=${encode(value)}`)
		.sort()
		.join("&");
	const path = input.url.pathname.split("/").map(encode).join("/");
	const signed = "host;x-amz-content-sha256;x-amz-date";
	const canonical = [
		input.method,
		path,
		query,
		`host:${input.url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${stamp}\n`,
		signed,
		payload,
	].join("\n");
	const scope = `${day}/${region}/s3/aws4_request`;
	const key = hmac(
		hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), region), "s3"),
		"aws4_request",
	);
	const signature = createHmac("sha256", key)
		.update(["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n"))
		.digest("hex");
	return {
		"x-amz-content-sha256": payload,
		"x-amz-date": stamp,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
	};
}

async function r2Fetch(
	config: R2Configuration,
	method: string,
	key: string,
	options: {
		query?: Record<string, string>;
		body?: string | Uint8Array;
		/** Unsigned request headers (content type, range). */
		headers?: Record<string, string>;
	} = {},
) {
	const url = new URL(
		`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}${key ? `/${key}` : ""}`,
	);
	for (const [name, value] of Object.entries(options.query ?? {}))
		url.searchParams.set(name, value);
	const body = options.body ?? "";
	return fetch(url, {
		method,
		redirect: "manual",
		signal: AbortSignal.timeout(60_000),
		headers: {
			...options.headers,
			...signedR2Headers({ method, url, body, ...config }),
		},
		...(options.body === undefined
			? {}
			: {
					body:
						typeof body === "string" ? body : new Blob([new Uint8Array(body)]),
				}),
	});
}

/** Stores one binary object under `key` (no Supabase-shaped wrapper). */
export async function r2PutObject(
	config: R2Configuration,
	key: string,
	body: Uint8Array,
	contentType: string,
) {
	const stored = await r2Fetch(config, "PUT", key, {
		body,
		headers: { "content-type": contentType },
	});
	if (!stored.ok) throw new Error(`R2 upload failed (${stored.status}).`);
}

/** Reads one object; a range header passes through for media seeking. */
export function r2GetObject(
	config: R2Configuration,
	key: string,
	range?: string | null,
) {
	return r2Fetch(config, "GET", key, range ? { headers: { range } } : {});
}

const xmlText = (text: string) =>
	text
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");

async function listKeys(
	config: R2Configuration,
	prefix: string,
	wanted: number,
) {
	const keys: string[] = [];
	let token: string | undefined;
	do {
		const listed = await r2Fetch(config, "GET", "", {
			query: {
				"list-type": "2",
				prefix,
				"max-keys": "1000",
				...(token ? { "continuation-token": token } : {}),
			},
		});
		if (!listed.ok) return null;
		const xml = await listed.text();
		for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g))
			keys.push(xmlText(match[1]));
		const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(
			xml,
		)?.[1];
		token =
			/<IsTruncated>true<\/IsTruncated>/.test(xml) && next
				? xmlText(next)
				: undefined;
	} while (token && keys.length < wanted);
	return keys;
}

/**
 * Serves the storage adapter's Supabase-shaped calls from R2, so every caller
 * (checkpoints, context archives) is unchanged. Object paths are identical.
 */
export async function r2Request(
	config: R2Configuration,
	bucket: string,
	path: string,
	options: RequestInit,
): Promise<Response> {
	const method = options.method ?? "GET";
	const json = (value: unknown, status = 200) =>
		new Response(JSON.stringify(value), { status });
	const body = () => JSON.parse(String(options.body ?? "{}"));
	if (path.startsWith("bucket")) {
		// R2 buckets are private unless a public domain is attached explicitly.
		const found = await r2Fetch(config, "HEAD", "");
		return found.ok
			? json({ public: false })
			: json({ error: "unavailable" }, found.status);
	}
	if (path === `object/list/${bucket}`) {
		const { prefix, search = "", offset = 0, limit = 100 } = body();
		const keys = await listKeys(config, `${prefix}${search}`, offset + limit);
		if (!keys) return json({ error: "list failed" }, 502);
		return json(
			keys
				.sort()
				.slice(offset, offset + limit)
				.map((key) => ({ name: key.slice(prefix.length) })),
		);
	}
	if (path === `object/${bucket}` && method === "DELETE") {
		for (const key of body().prefixes as string[]) {
			const removed = await r2Fetch(config, "DELETE", key);
			if (!removed.ok && removed.status !== 404)
				return json({ error: "delete failed" }, removed.status);
		}
		return json({});
	}
	const key = path.slice(`object/${bucket}/`.length);
	if (method === "POST") {
		const stored = await r2Fetch(config, "PUT", key, {
			body: String(options.body),
		});
		return stored.ok
			? json({})
			: json({ error: "upload failed" }, stored.status);
	}
	return r2Fetch(config, "GET", key);
}
