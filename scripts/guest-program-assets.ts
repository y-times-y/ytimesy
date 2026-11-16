import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	buildClaudeBoxTools,
	CLAUDE_BOX_TOOLS_BUNDLE,
} from "./build-claude-box-tools";

const GUEST_PROGRAM =
	/readFileSync\(\s*new URL\("([^"\n]+\.(?:py|mjs))", import\.meta\.url\),\s*"utf8",?\s*\)/g;

/**
 * Guest programs (Python run inside task VMs, and the Claude runner box's
 * bundled tool server) are read beside their module in development; bundles
 * for Workers or production cannot read the checkout, so each read is
 * replaced with the file's contents at build time. The box tool server is
 * built first (scripts/build-claude-box-tools.ts).
 */
export async function inlineGuestPrograms(path: string, contents: string) {
	if (
		!path.includes("/src/server/") ||
		!(contents.includes(".py") || contents.includes(".mjs"))
	)
		return null;
	let changed = contents;
	for (const match of [...contents.matchAll(GUEST_PROGRAM)]) {
		const file = resolve(dirname(path), match[1]);
		if (file === CLAUDE_BOX_TOOLS_BUNDLE) await buildClaudeBoxTools();
		const asset = await readFile(file, "utf8");
		// A function, so `$&` or `$'` in the asset (minified JavaScript has
		// them) is inserted as written, not read as a replacement pattern.
		changed = changed.replace(match[0], () => JSON.stringify(asset));
	}
	return changed === contents ? null : changed;
}
