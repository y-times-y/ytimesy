import { randomUUID } from "node:crypto";
import { z } from "zod";
import { seal, unseal } from "#/server/auth/token-vault";
import { database } from "./database";

export const mcpServerInput = z.object({
	name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
	url: z
		.string()
		.url()
		.max(2048)
		.refine((url) => url.startsWith("https://"), "MCP servers must use HTTPS."),
	headers: z
		.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(4096))
		.default({}),
	projectId: z.string().uuid().nullable().default(null),
	pluginId: z.string().min(1).max(200).nullable().default(null),
});

/** What clients may see: header names only, never their values. */
export type PublicMcpServer = {
	id: string;
	name: string;
	url: string;
	headerNames: string[];
	projectId: string | null;
	pluginId: string | null;
	enabled: boolean;
};

type Row = {
	id: string;
	name: string;
	url: string;
	sealed_headers: string | null;
	header_names: string[];
	project_id: string | null;
	plugin_id: string | null;
	enabled: boolean;
};

const publicServer = (row: Row): PublicMcpServer => ({
	id: row.id,
	name: row.name,
	url: row.url,
	headerNames: row.header_names,
	projectId: row.project_id,
	pluginId: row.plugin_id,
	enabled: row.enabled,
});

export async function addMcpServer(
	userId: string,
	input: z.input<typeof mcpServerInput>,
) {
	const server = mcpServerInput.parse(input);
	const names = Object.keys(server.headers);
	const { rows } = await database().query<Row>(
		`insert into mcp_server(id,user_id,project_id,name,url,sealed_headers,header_names,plugin_id)
		 values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
		[
			randomUUID(),
			userId,
			server.projectId,
			server.name,
			server.url,
			names.length ? await seal(JSON.stringify(server.headers)) : null,
			names,
			server.pluginId,
		],
	);
	return publicServer(rows[0]);
}

export async function listMcpServers(
	userId: string,
): Promise<PublicMcpServer[]> {
	const { rows } = await database().query<Row>(
		"select * from mcp_server where user_id=$1 order by name",
		[userId],
	);
	return rows.map(publicServer);
}

export async function setMcpServerEnabled(
	userId: string,
	id: string,
	enabled: boolean,
) {
	await database().query(
		"update mcp_server set enabled=$3, updated_at=now() where user_id=$1 and id=$2",
		[userId, id, enabled],
	);
}

export async function removeMcpServer(userId: string, id: string) {
	await database().query("delete from mcp_server where user_id=$1 and id=$2", [
		userId,
		id,
	]);
}

/** Server-side only: enabled personal servers plus this project's, with unsealed headers. */
export async function connectableMcpServers(
	userId: string,
	projectId: string | null,
) {
	const { rows } = await database().query<Row>(
		`select * from mcp_server where user_id=$1 and enabled
		 and (project_id is null or project_id=$2) order by name`,
		[userId, projectId],
	);
	return Promise.all(
		rows.map(async (row) => ({
			name: row.name,
			url: row.url,
			headers: row.sealed_headers
				? (JSON.parse(await unseal(row.sealed_headers)) as Record<
						string,
						string
					>)
				: {},
		})),
	);
}
