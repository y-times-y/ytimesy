import { randomUUID } from "node:crypto";
import { catalogIds } from "#/domain/plugin-catalog";
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

type PublicPluginInstall = {
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

/**
 * Deletes the user's installs of plugins dropped from the catalog, with their
 * MCP servers. Servers the user added themselves have no plugin_id and stay.
 */
export async function pruneRemovedInstalls(
	userId: string,
	ids: string[] = catalogIds(),
) {
	await database().query(
		`delete from mcp_server where user_id=$1 and plugin_id in
		 (select id::text from plugin_install where user_id=$1 and not (catalog_id = any($2)))`,
		[userId, ids],
	);
	await database().query(
		"delete from plugin_install where user_id=$1 and not (catalog_id = any($2))",
		[userId, ids],
	);
}

/** Enabled personal installs plus this project's, for commands and skills. */
export async function enabledPluginComponents(
	userId: string,
	projectId: string | null,
) {
	const { rows } = await database().query<Row>(
		`select * from plugin_install where user_id=$1 and enabled
		 and (project_id is null or project_id=$2) and catalog_id = any($3)
		 order by plugin_name`,
		[userId, projectId, catalogIds()],
	);
	return rows.map((row) => ({ plugin: row.plugin_name, ...row.components }));
}

/** A plugin skill as a turn lists it: everything stored but its body. */
export type PluginSkillSummary = Omit<PluginSkill, "body"> & {
	readonly body?: undefined;
};

const SKILLS_ARRAY_SQL =
	"case when jsonb_typeof(components->'skills')='array' then components->'skills' else '[]'::jsonb end";

/**
 * The skills of enabledPluginComponents without their bodies (and without
 * the commands' templates and the rest of `components`, which a turn does not
 * read): the bodies are most of an install's size and a turn loads one only
 * when the agent asks for it (pluginSkillBody).
 */
export async function enabledPluginSkillIndex(
	userId: string,
	projectId: string | null,
): Promise<{ id: string; plugin: string; skills: PluginSkillSummary[] }[]> {
	const { rows } = await database().query<{
		id: string;
		plugin_name: string;
		skills: PluginSkillSummary[];
	}>(
		`select id::text as id, plugin_name,
		  coalesce((select jsonb_agg(case when jsonb_typeof(s)='object' then s - 'body' else s end order by o)
		   from jsonb_array_elements(${SKILLS_ARRAY_SQL}) with ordinality e(s, o)), '[]'::jsonb) as skills
		 from plugin_install where user_id=$1 and enabled
		 and (project_id is null or project_id=$2) and catalog_id = any($3)
		 order by plugin_name`,
		[userId, projectId, catalogIds()],
	);
	return rows.map((row) => ({
		id: row.id,
		plugin: row.plugin_name,
		skills: row.skills,
	}));
}

/**
 * One skill's body from the install a turn listed (enabledPluginSkillIndex):
 * the first skill of that name, as the listing found it. Not found is null.
 */
export async function pluginSkillBody(
	userId: string,
	installId: string,
	skill: string,
): Promise<{ body: PluginSkill["body"] | undefined } | null> {
	const { rows } = await database().query<{
		body: PluginSkill["body"] | null;
	}>(
		`select e.s->'body' as body
		 from plugin_install, jsonb_array_elements(${SKILLS_ARRAY_SQL}) with ordinality e(s, o)
		 where user_id=$1 and id::text=$2 and e.s->'name' = to_jsonb($3::text)
		 order by e.o limit 1`,
		[userId, installId, skill],
	);
	return rows[0] ? { body: rows[0].body ?? undefined } : null;
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
