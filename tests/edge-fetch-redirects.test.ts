import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return /\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)
				? [path]
				: [];
		}),
	);
	return nested.flat();
}

// Cloudflare Workers throw on redirect: "error" for every request ("won't be
// implemented ... use manual"). With "manual" a 3xx arrives as a non-ok
// response, which every caller already rejects, so redirects are still refused.
it("never asks Workers fetch for redirect: error", async () => {
	const offenders: string[] = [];
	for (const file of await sourceFiles("src"))
		if (/redirect:\s*["']error["']/.test(await readFile(file, "utf8")))
			offenders.push(file);
	expect(offenders).toEqual([]);
});
