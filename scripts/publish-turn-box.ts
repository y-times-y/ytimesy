/**
 * Publishes the built turn box program (scripts/build-turn-box.ts) to the
 * private R2 bucket the edge serves it from (src/server/edge/turn-box-bundle.ts):
 *
 *   CLOUDFLARE_API_TOKEN=... node --import tsx scripts/publish-turn-box.ts [--bucket NAME]
 *
 * The program goes under turn-box/<sha256 prefix>.mjs.gz; the manifest
 * turn-box/latest.json is written last, so a box never sees a half-uploaded
 * version. New boxes download whatever the manifest names.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { buildTurnBox } from "./build-turn-box";

const API = "https://api.cloudflare.com/client/v4";

function flag(name: string) {
	const at = process.argv.indexOf(name);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

async function cloudflare(path: string, init: RequestInit = {}) {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set.");
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: { authorization: `Bearer ${token}`, ...init.headers },
	});
	if (!response.ok)
		throw new Error(`Cloudflare ${path} answered ${response.status}.`);
	return response;
}

const bucket = flag("--bucket") ?? "ytimesy-checkpoints-production";
const accounts = (await (await cloudflare("/accounts")).json()) as {
	result: { id: string }[];
};
const account = accounts.result[0]?.id;
if (!account) throw new Error("No Cloudflare account.");

const source = readFileSync(await buildTurnBox());
const sha256 = createHash("sha256").update(source).digest("hex");
const key = `turn-box/${sha256.slice(0, 32)}.mjs.gz`;
const put = (objectKey: string, body: Uint8Array | string, type: string) =>
	cloudflare(
		`/accounts/${account}/r2/buckets/${bucket}/objects/${encodeURIComponent(objectKey)}`,
		{
			method: "PUT",
			headers: { "content-type": type },
			body: typeof body === "string" ? body : new Blob([new Uint8Array(body)]),
		},
	);
await put(key, gzipSync(source, { level: 9 }), "application/gzip");
await put(
	"turn-box/latest.json",
	JSON.stringify({ key, sha256, version: sha256.slice(0, 12) }),
	"application/json",
);
console.log(`Published ${key} (version ${sha256.slice(0, 12)}).`);
