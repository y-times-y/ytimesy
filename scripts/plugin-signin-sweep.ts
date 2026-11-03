// Checks every catalog plugin's sign-in the way production starts it: reads
// each plugin at its pinned commit, sees how each tool server authenticates,
// and runs the real sign-in start up to the provider's authorization page.
// Fetch refuses redirect "error" like Cloudflare Workers do. Nothing is stored
// or installed; some providers record a dynamic client registration.
//
//   node --env-file=.env --import tsx scripts/plugin-signin-sweep.ts [plugin-id]
//
// Run it after changing sign-in code or the catalog (2026-11-03: 13 servers
// signed in; PagerDuty/Render/Datadog take tokens; GitHub/Slack need our
// registered apps; Vercel and Figma refused us and were removed).
import { randomBytes } from "node:crypto";
import { auth } from "@ai-sdk/mcp";
import { PLUGIN_CATALOG } from "#/domain/plugin-catalog";
import { parsePlugin } from "#/domain/plugin-package";
import { fetchPinnedPlugin } from "#/server/adapters/plugin-source";
import { redirectRefusingFetch } from "#/server/adapters/workers-fetch";
import {
	mcpClientMetadataUrl,
	mcpOAuthRedirectUrl,
	type OAuthRecord,
	requiresOAuth,
	storedOAuthProvider,
} from "#/server/services/mcp-oauth";
import { mcpSignInStartFailure } from "#/server/services/mcp-oauth-client";

const APP_URL = "https://ytimesy.com";
const workersStrict: typeof fetch = (input, init) => {
	if (init?.redirect === "error")
		throw new TypeError(
			'Invalid redirect value, must be one of "follow" or "manual" (Workers)',
		);
	return fetch(input, init);
};
const prodFetch = redirectRefusingFetch(workersStrict);
const only = process.argv[2];

for (const entry of PLUGIN_CATALOG) {
	if (only && entry.id !== only) continue;
	let servers: { name: string; url: string; headers: Record<string, string> }[];
	try {
		const plugin = parsePlugin(await fetchPinnedPlugin(entry), entry.id);
		servers = plugin.mcpServers.map((server) => ({
			name: server.name,
			url: entry.signInUrls?.[server.name] ?? server.url,
			headers: server.headers,
		}));
	} catch (error) {
		console.log(
			`${entry.id.padEnd(16)} PLUGIN READ FAILED: ${String(error).slice(0, 160)}`,
		);
		continue;
	}
	if (!servers.length) {
		console.log(
			`${entry.id.padEnd(16)} no tool servers (skills/commands only)`,
		);
		continue;
	}
	for (const server of servers) {
		const label = `${entry.id}/${server.name}`.padEnd(30);
		const credential = Object.values({
			url: server.url,
			...server.headers,
		}).some((v) => v.includes("${"));
		if (!server.url.startsWith("https://")) {
			console.log(`${label} needs settings (url ${server.url.slice(0, 50)})`);
			continue;
		}
		const oauth = await requiresOAuth(server.url, prodFetch).catch(() => false);
		if (!oauth) {
			console.log(
				`${label} ${credential ? "API key/token in settings" : "no sign-in needed"}${entry.signInApp ? ` (or ${entry.signInApp} app sign-in)` : ""}`,
			);
			continue;
		}
		const record: OAuthRecord = {};
		const provider = storedOAuthProvider({
			record,
			redirectUrl: mcpOAuthRedirectUrl(APP_URL),
			persist: async () => {},
			state: randomBytes(16).toString("base64url"),
			choose: {
				clientMetadataUrl: mcpClientMetadataUrl(APP_URL),
				fetchFn: prodFetch,
			},
			env: process.env,
		});
		try {
			const result = await auth(provider, {
				serverUrl: server.url,
				fetchFn: prodFetch,
			});
			const host = provider.authorizationUrl
				? new URL(provider.authorizationUrl).host
				: "";
			console.log(
				`${label} OAuth: ${result === "REDIRECT" && host ? `OK -> ${host}` : `result ${result}`} (client: ${record.app ? `app ${record.app}` : record.dynamic ? "dynamic registration" : record.client ? "metadata document" : "?"})`,
			);
		} catch (error) {
			const shown = mcpSignInStartFailure(error);
			console.log(
				`${label} OAuth: FAILED ${String((error as Error)?.message ?? error).slice(0, 140)} | user sees: ${JSON.stringify(shown).slice(0, 140)}`,
			);
		}
	}
}
