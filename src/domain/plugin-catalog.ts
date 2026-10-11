/**
 * Our reviewed plugin marketplace. Only these plugins install officially, each
 * pinned to the exact commit that was reviewed; adding an entry is the review.
 * Anyone can request a plugin; developers can still have an agent use any
 * plugin inside its own VM, outside this catalog.
 */
export type PluginCatalogEntry = {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly owner: string;
	readonly repo: string;
	readonly sha: string;
	readonly path: string;
	/** The plugin's userConfig fields, copied at review so the UI can ask before installing. */
	readonly settings?: readonly {
		readonly key: string;
		readonly title: string;
		readonly description: string;
		readonly sensitive: boolean;
	}[];
};

export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [];

export const PLUGIN_REQUEST_URL =
	process.env.YTIMESY_PLUGIN_REQUEST_URL ?? null;
