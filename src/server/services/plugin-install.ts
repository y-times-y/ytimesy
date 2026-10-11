import { randomUUID } from "node:crypto";
import {
	PLUGIN_CATALOG,
	type PluginCatalogEntry,
} from "#/domain/plugin-catalog";
import { parsePlugin, resolvePluginHeaders } from "#/domain/plugin-package";
import { addMcpServer } from "../adapters/mcp-servers";
import { saveInstall } from "../adapters/plugin-installs";
import { fetchPinnedPlugin } from "../adapters/plugin-source";
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
}) {
	const entry = (input.catalog ?? PLUGIN_CATALOG).find(
		(candidate) => candidate.id === input.catalogId,
	);
	if (!entry) throw new Error("That plugin is not in the reviewed catalog.");
	const files = await fetchPinnedPlugin(entry, input.fetch);
	const plugin = parsePlugin(files, entry.id);
	for (const [key, option] of Object.entries(plugin.userConfig))
		if (option.required && !input.config[key])
			throw new Error(
				`"${option.title}" is required to install ${plugin.displayName}.`,
			);
	const servers = plugin.mcpServers.map((server) => ({
		name: `${plugin.name}-${server.name}`.slice(0, 32),
		url: server.url,
		headers: resolvePluginHeaders(server.headers, input.config),
	}));
	const probe = await connectMcpTools(servers, { fetch: input.mcpFetch });
	await probe.close();
	if (probe.unavailable.length)
		throw new Error(
			`Could not connect ${probe.unavailable.join(", ")}. Check the plugin's settings.`,
		);
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
			unsupported: plugin.unsupported,
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
	return { id, plugin: plugin.displayName, unsupported: plugin.unsupported };
}
