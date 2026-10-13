import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const GUEST_PROGRAM =
	/readFileSync\(\s*new URL\("([^"\n]+\.py)", import\.meta\.url\),\s*"utf8",?\s*\)/g;

/**
 * Guest programs (Python run inside task VMs) are read beside their module in
 * development; bundles for Workers or production cannot read the checkout, so
 * each read is replaced with the file's contents at build time.
 */
export async function inlineGuestPrograms(path: string, contents: string) {
	if (!path.includes("/src/server/") || !contents.includes(".py")) return null;
	let changed = contents;
	for (const match of [...contents.matchAll(GUEST_PROGRAM)]) {
		const asset = await readFile(resolve(dirname(path), match[1]), "utf8");
		changed = changed.replace(match[0], JSON.stringify(asset));
	}
	return changed === contents ? null : changed;
}
