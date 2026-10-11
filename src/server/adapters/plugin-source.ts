import { gunzipSync } from "node:zlib";

/** A reviewed plugin pinned to an exact commit; what we reviewed is what installs. */
export type PinnedPluginSource = {
	owner: string;
	repo: string;
	sha: string;
	/** Plugin folder inside the repository ("" for the root). */
	path: string;
};

const MAX_ARCHIVE = 20 * 1024 * 1024;
const MAX_TEXT_FILE = 256 * 1024;
const MAX_FILES = 2000;

function field(block: Buffer, offset: number, length: number) {
	const raw = block.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** Minimal ustar/pax reader for GitHub tarballs: regular files only, bounded. */
export function readTarball(gzipped: Uint8Array) {
	const archive = gunzipSync(gzipped, { maxOutputLength: MAX_ARCHIVE });
	const files = new Map<string, Buffer>();
	let offset = 0;
	let longName: string | undefined;
	while (offset + 512 <= archive.length) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
		const type = String.fromCharCode(header[156] || 48);
		const body = archive.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			// pax extended header: "<len> key=value\n" records; path overrides the name.
			const path = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
			if (path) longName = path;
			continue;
		}
		if (type === "L") {
			longName = body.toString("utf8").replace(/\0+$/, "");
			continue;
		}
		if (type === "g") continue;
		const prefix = field(header, 345, 155);
		const name =
			longName ??
			(prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
		longName = undefined;
		if (type !== "0" && type !== "\0") continue;
		if (files.size >= MAX_FILES)
			throw new Error("Plugin archive has too many files.");
		files.set(name, Buffer.from(body));
	}
	return files;
}

/** Plugin files relative to the plugin root; only .md/.json keep their contents. */
export function pluginFilesFromArchive(
	archive: ReadonlyMap<string, Buffer>,
	pluginPath: string,
) {
	const root = pluginPath.replace(/^\/+|\/+$/g, "");
	const files = new Map<string, string>();
	for (const [name, body] of archive) {
		// GitHub prefixes every entry with "<owner>-<repo>-<sha>/".
		const relative = name.split("/").slice(1).join("/");
		if (root && !relative.startsWith(`${root}/`)) continue;
		const path = root ? relative.slice(root.length + 1) : relative;
		if (!path || path.split("/").some((part) => part === ".." || part === ""))
			continue;
		const text = /\.(md|json)$/.test(path) && body.length <= MAX_TEXT_FILE;
		files.set(path, text ? body.toString("utf8") : "");
	}
	return files;
}

export async function fetchPinnedPlugin(
	source: PinnedPluginSource,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
	if (
		!/^[A-Za-z0-9-]{1,39}$/.test(source.owner) ||
		!/^[A-Za-z0-9._-]{1,100}$/.test(source.repo) ||
		!/^[a-f0-9]{40}$/.test(source.sha)
	)
		throw new Error(
			"Plugin source must be a GitHub repository pinned to a full commit.",
		);
	const response = await fetchImpl(
		`https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.sha}`,
		{ redirect: "error", signal: AbortSignal.timeout(30_000) },
	);
	if (!response.ok)
		throw new Error(`Could not download the plugin (${response.status}).`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length > MAX_ARCHIVE)
		throw new Error("Plugin archive is too large.");
	return pluginFilesFromArchive(readTarball(bytes), source.path);
}
