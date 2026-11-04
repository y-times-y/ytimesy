import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { inlineGuestPrograms } from "./scripts/guest-program-assets.ts";
import { assertProductionBuildAnalytics } from "./scripts/production-settings.ts";
import { terminalWebsocketPlugin } from "./src/server/terminal-vite-plugin.ts";

/** Production bundles cannot read guest programs from the checkout at runtime. */
function guestProgramAssets(): Plugin {
	return {
		name: "ytimesy-guest-program-assets",
		apply: "build",
		enforce: "pre",
		async transform(code, id) {
			const path = id.split("?")[0];
			if (!path.endsWith(".ts")) return null;
			const inlined = await inlineGuestPrograms(path, code);
			return inlined === null ? null : { code: inlined, map: null };
		},
	};
}

/**
 * The Freestyle SDK opens VM terminals with the `ws` package; on Workers it uses
 * the runtime's WebSocket through the same adapter the edge executor bundles.
 */
function workerWebSockets(): Plugin {
	return {
		name: "ytimesy-worker-websockets",
		enforce: "pre",
		resolveId(source, importer) {
			if (source === "ws" && importer?.includes("/freestyle/"))
				return resolve("src/server/edge/freestyle-websocket.ts");
			return null;
		},
	};
}

/** Fails a production web build that would ship without browser analytics. */
function productionAnalyticsGuard(): Plugin {
	return {
		name: "ytimesy-production-analytics-guard",
		apply: "build",
		config(_, { mode }) {
			assertProductionBuildAnalytics({
				...loadEnv(mode, process.cwd(), "VITE_"),
				...process.env,
			});
		},
	};
}

/**
 * Bakes the build id (src/lib/build-id.ts) into the page and the web Worker
 * alike: the production deploy passes YTIMESY_BUILD_ID, other builds get a
 * fresh one, and the dev server stays "development".
 */
function buildIdentity(): Plugin {
	return {
		name: "ytimesy-build-identity",
		config(_, { command }) {
			const id =
				process.env.YTIMESY_BUILD_ID ||
				(command === "build" ? `local-${Date.now().toString(36)}` : "");
			return { define: { __YTIMESY_BUILD_ID__: JSON.stringify(id) } };
		},
	};
}

// The local dev server runs on Node; YTIMESY_TARGET=cloudflare builds the web Worker.
const cloudflareTarget = process.env.YTIMESY_TARGET === "cloudflare";

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	// The code-highlighting worker loads Shiki grammars on demand (dynamic imports).
	worker: { format: "es" },
	plugins: [
		...(cloudflareTarget
			? [
					cloudflare({
						viteEnvironment: { name: "ssr" },
						configPath:
							process.env.YTIMESY_WRANGLER_CONFIG ?? "wrangler.web.jsonc",
					}),
					workerWebSockets(),
				]
			: []),
		tanstackStart(),
		viteReact(),
		tailwindcss(),
		terminalWebsocketPlugin(),
		guestProgramAssets(),
		productionAnalyticsGuard(),
		buildIdentity(),
	],
});

export default config;
