/** Replaced at build time (vite.config.ts, scripts/build-edge-executor.ts). */
declare const __YTIMESY_BUILD_ID__: string | undefined;

/**
 * This build's id: the deploy script's YTIMESY_BUILD_ID, or "development"
 * for a dev server, a test, or a build without one. The page and the web
 * Worker of one deploy share it, so a tab can tell a newer deploy apart.
 */
export const BUILD_ID: string =
	typeof __YTIMESY_BUILD_ID__ === "string" && __YTIMESY_BUILD_ID__
		? __YTIMESY_BUILD_ID__
		: "development";

/** The response header (pages, API routes) that carries the server's BUILD_ID. */
export const BUILD_ID_HEADER = "x-ytimesy-build";
