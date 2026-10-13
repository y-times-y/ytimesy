import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

/** A reviewed plugin pinned to an exact commit; what we reviewed is what installs. */
type PinnedPluginSource = {
	owner: string;
	repo: string;
	sha: string;
	/** Plugin folder inside the repository ("" for the root). */
	path: string;
};

// Monorepos can be large; only the plugin folder is kept, the rest is skipped while streaming.
const MAX_SCANNED = 500 * 1024 * 1024;
const MAX_TEXT_FILE = 256 * 1024;
const MAX_FILES = 2000;

function field(block: Buffer, offset: number, length: number) {
	const raw = block.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** Plugin-relative path for a GitHub tarball entry, or null when outside the plugin. */
function pluginRelative(name: string, root: string) {
	// GitHub prefixes every entry with "<owner>-<repo>-<sha>/".
	const relative = name.split("/").slice(1).join("/");
	if (root && !relative.startsWith(`${root}/`)) return null;
	const path = root ? relative.slice(root.length + 1) : relative;
	if (!path || path.split("/").some((part) => part === ".." || part === ""))
		return null;
	return path;
}

/**
 * Streams a gzipped GitHub tarball (ustar/pax), keeping only regular files in
 * the plugin folder; .md/.json keep their contents, others are kept by path.
 */
async function pluginFilesFromTarball(
	gzipped: AsyncIterable<Uint8Array> | Uint8Array,
	pluginPath: string,
) {
	const root = pluginPath.replace(/^\/+|\/+$/g, "");
	const files = new Map<string, string>();
	const source =
		gzipped instanceof Uint8Array
			? Readable.from([gzipped])
			: Readable.from(gzipped);
	let pending = Buffer.alloc(0);
	let scanned = 0;
	let longName: string | undefined;
	let current:
		| {
				remaining: number;
				padding: number;
				path: string | null;
				type: string;
				parts: Buffer[];
				size: number;
		  }
		| undefined;
	const finishEntry = () => {
		if (!current) return;
		const body = Buffer.concat(current.parts);
		if (current.type === "x") {
			const path = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
			if (path) longName = path;
		} else if (current.type === "L") {
			longName = body.toString("utf8").replace(/\0+$/, "");
		} else if (
			current.path !== null &&
			(current.type === "0" || current.type === "\0")
		) {
			if (files.size >= MAX_FILES)
				throw new Error("Plugin has too many files.");
			const text =
				/\.(md|json)$/.test(current.path) && current.size <= MAX_TEXT_FILE;
			files.set(current.path, text ? body.toString("utf8") : "");
		}
		current = undefined;
	};
	for await (const chunk of source.pipe(createGunzip())) {
		scanned += chunk.length;
		if (scanned > MAX_SCANNED) throw new Error("Plugin archive is too large.");
		pending = Buffer.concat([pending, chunk as Buffer]);
		while (true) {
			if (current) {
				const take = Math.min(current.remaining, pending.length);
				// Keep bytes only for metadata records and wanted text files.
				const keep =
					current.type === "x" ||
					current.type === "L" ||
					(current.path !== null && current.size <= MAX_TEXT_FILE);
				if (keep) current.parts.push(pending.subarray(0, take));
				pending = pending.subarray(take);
				current.remaining -= take;
				if (current.remaining > 0) break;
				const padding = Math.min(current.padding, pending.length);
				pending = pending.subarray(padding);
				current.padding -= padding;
				if (current.padding > 0) break;
				finishEntry();
				continue;
			}
			if (pending.length < 512) break;
			const header = pending.subarray(0, 512);
			pending = pending.subarray(512);
			if (header.every((byte) => byte === 0)) continue;
			const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
			const type = String.fromCharCode(header[156] || 48);
			let path: string | null = null;
			if (type !== "x" && type !== "L" && type !== "g") {
				const prefix = field(header, 345, 155);
				const name =
					longName ??
					(prefix
						? `${prefix}/${field(header, 0, 100)}`
						: field(header, 0, 100));
				longName = undefined;
				path = pluginRelative(name, root);
			}
			current = {
				remaining: size,
				padding: (512 - (size % 512)) % 512,
				path,
				type,
				parts: [],
				size,
			};
			if (size === 0) {
				finishEntry();
			}
		}
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
		{ redirect: "manual", signal: AbortSignal.timeout(120_000) },
	);
	if (!response.ok || !response.body)
		throw new Error(`Could not download the plugin (${response.status}).`);
	return pluginFilesFromTarball(
		response.body as unknown as AsyncIterable<Uint8Array>,
		source.path,
	);
}
