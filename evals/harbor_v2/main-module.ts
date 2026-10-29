import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * True when this module is the script node was started with. Inside a
 * bundle every module shares the bundle's import.meta.url, so the URL alone
 * would make an imported CLI module run its command line in the bridge;
 * the started script must also carry the module's own file name.
 */
export function isMainModule(
	moduleUrl: string,
	name: string,
	argv1: string | undefined = process.argv[1],
) {
	if (!argv1) return false;
	const file = basename(argv1).replace(/\.(?:ts|mts|js|mjs)$/, "");
	return file === name && moduleUrl === pathToFileURL(argv1).href;
}
