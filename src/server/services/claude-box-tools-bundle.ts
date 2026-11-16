import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The Claude runner box's tool server (src/server/claude-box-tools/), bundled
 * for Node by scripts/build-claude-box-tools.ts. Builds for Workers inline the
 * file here (scripts/guest-program-assets.ts builds it first); in development
 * it is read from the checkout. The version (its hash) names its copy on each
 * box, so a box receives each build once.
 */
let bundle: { source: string; version: string } | undefined;

export function claudeBoxToolsBundle(): { source: string; version: string } {
	if (!bundle) {
		const source: string = readFileSync(
			new URL("../../../.ytimesy/claude-box-tools.mjs", import.meta.url),
			"utf8",
		);
		bundle = {
			source,
			version: createHash("sha256").update(source).digest("hex").slice(0, 32),
		};
	}
	return bundle;
}
