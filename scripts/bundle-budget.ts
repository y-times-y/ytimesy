// The browser code the workspace page ("/") loads before its first paint,
// measured from a production build, against the sizes recorded in
// scripts/bundle-budget.json. Used by scripts/check-bundle-size.ts (CI).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const BUNDLE_METRICS = [
	"entryJs",
	"firstLoadJs",
	"firstLoadCss",
] as const;
export type BundleMetric = (typeof BUNDLE_METRICS)[number];
/** Gzipped bytes per metric (what the browser downloads). */
export type BundleSizes = Record<BundleMetric, number>;

export type BundleBudget = {
	/** How far each metric may grow above its baseline, in percent. */
	readonly budgetPercent: number;
	/** Gzipped bytes recorded when the budget was last updated. */
	readonly baseline: BundleSizes;
};

type ManifestRoute = {
	readonly preloads?: readonly string[];
	readonly css?: readonly string[];
	readonly scripts?: readonly { readonly attrs?: { readonly src?: string } }[];
};

/**
 * The files each metric covers, from TanStack Start's route manifest in the
 * server build: the root script (entry), the root and "/" preloads (all JS
 * of a first load), and the main stylesheet with the "/" route's CSS.
 */
export async function firstLoadFiles(dist: string) {
	const serverAssets = join(dist, "server", "assets");
	const manifestFile = (await readdir(serverAssets)).find((name) =>
		/^_tanstack-start-manifest_v-.*\.js$/.test(name),
	);
	if (!manifestFile)
		throw new Error(`No TanStack Start manifest in ${serverAssets}.`);
	const { tsrStartManifest } = (await import(
		pathToFileURL(join(serverAssets, manifestFile)).href
	)) as {
		tsrStartManifest: () => { routes: Record<string, ManifestRoute> };
	};
	const routes = tsrStartManifest().routes;
	const root = routes.__root__;
	const home = routes["/"];
	if (!root || !home) throw new Error("The manifest has no root or / route.");
	const entry = root.scripts?.find((script) => script.attrs?.src)?.attrs?.src;
	if (!entry) throw new Error("The manifest has no entry script.");
	const clientAssets = join(dist, "client", "assets");
	const mainCss = (await readdir(clientAssets)).filter((name) =>
		/^styles-.*\.css$/.test(name),
	);
	if (mainCss.length !== 1)
		throw new Error(`Expected one main stylesheet, found ${mainCss.length}.`);
	const unique = (paths: readonly string[]) => [...new Set(paths)];
	return {
		entryJs: [entry],
		firstLoadJs: unique([
			entry,
			...(root.preloads ?? []),
			...(home.preloads ?? []),
		]),
		firstLoadCss: unique([
			`/assets/${mainCss[0]}`,
			...(root.css ?? []),
			...(home.css ?? []),
		]),
	} satisfies Record<BundleMetric, string[]>;
}

export async function measureBundle(dist: string): Promise<BundleSizes> {
	const files = await firstLoadFiles(dist);
	const gzipped = async (paths: readonly string[]) => {
		let total = 0;
		for (const path of paths)
			total += gzipSync(await readFile(join(dist, "client", path)), {
				level: 9,
			}).length;
		return total;
	};
	return {
		entryJs: await gzipped(files.entryJs),
		firstLoadJs: await gzipped(files.firstLoadJs),
		firstLoadCss: await gzipped(files.firstLoadCss),
	};
}

export type BudgetResult = {
	readonly metric: BundleMetric;
	readonly baseline: number;
	readonly current: number;
	readonly limit: number;
	readonly over: boolean;
};

export function checkBudget(
	budget: BundleBudget,
	current: BundleSizes,
): BudgetResult[] {
	return BUNDLE_METRICS.map((metric) => {
		const baseline = budget.baseline[metric];
		const limit = Math.floor(baseline * (1 + budget.budgetPercent / 100));
		return {
			metric,
			baseline,
			current: current[metric],
			limit,
			over: current[metric] > limit,
		};
	});
}
