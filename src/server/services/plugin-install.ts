import { randomUUID } from "node:crypto";
import {
	PLUGIN_CATALOG,
	type PluginCatalogEntry,
} from "#/domain/plugin-catalog";
import {
	parsePlugin,
	resolvePluginHeaders,
	resolvePluginValue,
} from "#/domain/plugin-package";
import { addMcpServer } from "../adapters/mcp-servers";
import { saveInstall } from "../adapters/plugin-installs";
import { fetchPinnedPlugin } from "../adapters/plugin-source";
import { requiresOAuth } from "./mcp-oauth";
import { mcpOAuthAppCredentials } from "./mcp-oauth-client";

/**
 * Credential settings the user may leave empty for this plugin: those of a
 * catalog entry whose sign-in app the owner has configured.
 */
export function signInReplacesSettings(
	entry: PluginCatalogEntry,
	env?: Record<string, string | undefined>,
): Set<string> {
	if (!entry.signInApp || !mcpOAuthAppCredentials(entry.signInApp, env))
		return new Set();
	return new Set(
		(entry.settings ?? [])
			.filter((setting) => setting.sensitive)
			.map((setting) => setting.key),
	);
}

import { connectMcpTools } from "./mcp-tools";

/**
 * Installs a plugin from our reviewed catalog only: fetch at the reviewed
 * commit, parse, require its settings, connect its HTTP MCP servers once, then
 * save. Unsupported parts (stdio servers, hooks, agents) are reported, not run.
 */
export async function installCatalogPlugin(input: {
	userId: string;
	catalogId: string;
	projectId: string | null;
	config: Record<string, string>;
	catalog?: readonly PluginCatalogEntry[];
	fetch?: typeof globalThis.fetch;
	mcpFetch?: typeof globalThis.fetch;
	env?: Record<string, string | undefined>;
}) {
	const entry = (input.catalog ?? PLUGIN_CATALOG).find(
		(candidate) => candidate.id === input.catalogId,
	);
	if (!entry) throw new Error("That plugin is not in the reviewed catalog.");
	const files = await fetchPinnedPlugin(entry, input.fetch);
	const plugin = parsePlugin(files, entry.id);
	const optional = signInReplacesSettings(entry, input.env);
	for (const [key, option] of Object.entries(plugin.userConfig))
		if (option.required && !input.config[key] && !optional.has(key))
			throw new Error(
				`"${option.title}" is required to install ${plugin.displayName}.`,
			);
	const candidates = plugin.mcpServers.map((server) => {
		const url =
			entry.signInUrls?.[server.name] ??
			resolvePluginValue(server.url, input.config);
		if (!url.startsWith("https://"))
			throw new Error(`${server.name} must resolve to an HTTPS URL.`);
		// A credential left empty because the owner's app signs the user in.
		const signInOnly = Object.values(server.headers).some((value) =>
			[...optional].some((key) => value.includes(key) && !input.config[key]),
		);
		return {
			name: `${plugin.name}-${server.name}`.slice(0, 32),
			url,
			signInOnly,
			headers: signInOnly
				? {}
				: resolvePluginHeaders(server.headers, input.config),
			// A server whose config takes a credential from the user's settings.
			usesCredential: Object.values({
				url: server.url,
				...server.headers,
			}).some((value) => value.includes("${")),
		};
	});
	const probe = await connectMcpTools(
		candidates.filter((server) => !server.signInOnly),
		{ fetch: input.mcpFetch },
	);
	await probe.close();
	const unavailable = new Set(probe.unavailable);
	const signInOnly = new Set(
		candidates.filter((server) => server.signInOnly).map((s) => s.name),
	);
	const wrongCredential = candidates.filter(
		(server) =>
			unavailable.has(server.name) &&
			server.usesCredential &&
			!server.signInOnly,
	);
	if (wrongCredential.length)
		throw new Error(
			`Could not connect ${wrongCredential.map((server) => server.name).join(", ")}. Check the plugin's settings.`,
		);
	// Servers with no credential in their config sign the user in (OAuth): they
	// install as OAuth servers and join turns once the user signs in.
	const servers: {
		name: string;
		url: string;
		headers: Record<string, string>;
		auth: "headers" | "oauth";
	}[] = [];
	const unreachable: string[] = [];
	for (const {
		usesCredential: _usesCredential,
		signInOnly: _signInOnly,
		...server
	} of candidates)
		if (signInOnly.has(server.name))
			servers.push({ ...server, headers: {}, auth: "oauth" });
		else if (!unavailable.has(server.name))
			servers.push({ ...server, auth: "headers" });
		else if (await requiresOAuth(server.url, input.mcpFetch))
			servers.push({ ...server, headers: {}, auth: "oauth" });
		else unreachable.push(server.name);
	const unsupported = [
		...plugin.unsupported,
		...unreachable.map(
			(name) => `MCP server ${name} could not be reached at install`,
		),
	];
	const needsSignIn = servers
		.filter((server) => server.auth === "oauth")
		.map((server) => server.name);
	const id = randomUUID();
	await saveInstall({
		id,
		userId: input.userId,
		projectId: input.projectId,
		catalogId: entry.id,
		pluginName: plugin.name,
		commitSha: entry.sha,
		config: input.config,
		components: {
			skills: plugin.skills,
			commands: plugin.commands,
			mcpServers: servers.map((server) => server.name),
			unsupported,
			version: plugin.version,
			description: plugin.description,
		},
	});
	for (const server of servers)
		await addMcpServer(input.userId, {
			...server,
			projectId: input.projectId,
			pluginId: id,
		});
	return { id, plugin: plugin.displayName, unsupported, needsSignIn };
}
