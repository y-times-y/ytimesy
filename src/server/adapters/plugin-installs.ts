import { randomUUID } from "node:crypto";
import type { PluginCommand, PluginSkill } from "#/domain/plugin-package";
import { seal } from "#/server/auth/token-vault";
import { database } from "./database";

export type PluginComponents = {
	skills: PluginSkill[];
	commands: PluginCommand[];
	mcpServers: string[];
	unsupported: string[];
	version: string | null;
	description: string;
};

export type PublicPluginInstall = {
	id: string;
	catalogId: string;
	pluginName: string;
	commitSha: string;
	projectId: string | null;
	enabled: boolean;
	skills: string[];
	commands: string[];
	mcpServers: string[];
	unsupported: string[];
};

type Row = {
	id: string;
	catalog_id: string;
	plugin_name: string;
	commit_sha: string;
	project_id: string | null;
	enabled: boolean;
	components: PluginComponents;
};

export async function saveInstall(input: {
	id?: string;
	userId: string;
	projectId: string | null;
	catalogId: string;
	pluginName: string;
	commitSha: string;
	components: PluginComponents;
	config: Record<string, string>;
}) {
	const id = input.id ?? randomUUID();
	await database().query(
		`insert into plugin_install(id,user_id,project_id,catalog_id,plugin_name,commit_sha,components,sealed_config)
		 values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
		[
			id,
			input.userId,
			input.projectId,
			input.catalogId,
			input.pluginName,
			input.commitSha,
			JSON.stringify(input.components),
			Object.keys(input.config).length
				? await seal(JSON.stringify(input.config))
				: null,
		],
	);
	return id;
}

export async function listInstalls(
	userId: string,
): Promise<PublicPluginInstall[]> {
	const { rows } = await database().query<Row>(
		"select * from plugin_install where user_id=$1 order by plugin_name",
		[userId],
	);
	return rows.map((row) => ({
		id: row.id,
		catalogId: row.catalog_id,
		pluginName: row.plugin_name,
		commitSha: row.commit_sha,
		projectId: row.project_id,
		enabled: row.enabled,
		skills: row.components.skills.map((skill) => skill.name),
		commands: row.components.commands.map((command) => command.name),
		mcpServers: row.components.mcpServers,
		unsupported: row.components.unsupported,
	}));
}

/** Enabled personal installs plus this project's, for commands and skills. */
export async function enabledPluginComponents(
	userId: string,
	projectId: string | null,
) {
	const { rows } = await database().query<Row>(
		`select * from plugin_install where user_id=$1 and enabled
		 and (project_id is null or project_id=$2) order by plugin_name`,
		[userId, projectId],
	);
	return rows.map((row) => ({ plugin: row.plugin_name, ...row.components }));
}

/** Toggling or removing a plugin applies to its MCP servers too (tagged with the install id). */
export async function setInstallEnabled(
	userId: string,
	id: string,
	enabled: boolean,
) {
	await database().query(
		"update plugin_install set enabled=$3 where user_id=$1 and id=$2",
		[userId, id, enabled],
	);
	await database().query(
		"update mcp_server set enabled=$3, updated_at=now() where user_id=$1 and plugin_id=$2",
		[userId, id, enabled],
	);
}

export async function removeInstall(userId: string, id: string) {
	await database().query(
		"delete from mcp_server where user_id=$1 and plugin_id=$2",
		[userId, id],
	);
	await database().query(
		"delete from plugin_install where user_id=$1 and id=$2",
		[userId, id],
	);
}
