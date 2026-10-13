import { createHash, randomUUID } from "node:crypto";
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
	/** "oauth": the server signs the user in (MCP authorization) instead of headers. */
	auth: z.enum(["headers", "oauth"]).default("headers"),
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
	auth: "headers" | "oauth";
	/**
	 * OAuth servers: whether sign-in works, as last checked against the server.
	 * Never "signed-in" unless a request with the user's token succeeded.
	 */
	signIn: McpSignInState | null;
};

export type McpSignInState = "signed-in" | "needs-sign-in" | "unreachable";

type Row = {
	id: string;
	name: string;
	url: string;
	sealed_headers: string | null;
	header_names: string[];
	project_id: string | null;
	plugin_id: string | null;
	enabled: boolean;
	auth: "headers" | "oauth";
	sealed_oauth: string | null;
};

const publicServer = (row: Row): PublicMcpServer => ({
	id: row.id,
	name: row.name,
	url: row.url,
	headerNames: row.header_names,
	projectId: row.project_id,
	pluginId: row.plugin_id,
	enabled: row.enabled,
	auth: row.auth,
	// Unchecked rows never claim a sign-in; the service verifies before listing.
	signIn: row.auth === "oauth" ? "needs-sign-in" : null,
});

export async function addMcpServer(
	userId: string,
	input: z.input<typeof mcpServerInput>,
) {
	const server = mcpServerInput.parse(input);
	const names = Object.keys(server.headers);
	const { rows } = await database().query<Row>(
		`insert into mcp_server(id,user_id,project_id,name,url,sealed_headers,header_names,plugin_id,auth)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
		[
			randomUUID(),
			userId,
			server.projectId,
			server.name,
			server.url,
			names.length ? await seal(JSON.stringify(server.headers)) : null,
			names,
			server.pluginId,
			server.auth,
		],
	);
	return publicServer(rows[0]);
}

/** Server-side only: each server with its sealed OAuth record, for sign-in checks. */
export async function listMcpServersWithOAuth(userId: string) {
	const { rows } = await database().query<Row>(
		"select * from mcp_server where user_id=$1 order by name",
		[userId],
	);
	return rows.map((row) => ({
		server: publicServer(row),
		sealedOAuth: row.auth === "oauth" ? row.sealed_oauth : null,
	}));
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
			id: row.id,
			auth: row.auth,
			sealedOAuth: row.sealed_oauth,
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

/** Server-side only: one server with its sealed OAuth record. */
export async function mcpServerForOwner(userId: string, id: string) {
	const { rows } = await database().query<Row>(
		"select * from mcp_server where user_id=$1 and id=$2",
		[userId, id],
	);
	const row = rows[0];
	return row
		? {
				id: row.id,
				url: row.url,
				auth: row.auth,
				sealedOAuth: row.sealed_oauth,
			}
		: null;
}

export async function saveMcpOAuth(
	userId: string,
	id: string,
	sealedOAuth: string | null,
) {
	await database().query(
		"update mcp_server set sealed_oauth=$3, updated_at=now() where user_id=$1 and id=$2 and auth='oauth'",
		[userId, id, sealedOAuth],
	);
}

const stateHash = (state: string) =>
	createHash("sha256").update(state).digest("hex");

export async function saveMcpOAuthState(
	userId: string,
	serverId: string,
	state: string,
	verifier: string,
) {
	await database().query(
		"delete from mcp_oauth_state where expires_at < now()",
	);
	await database().query(
		`insert into mcp_oauth_state(state_hash,user_id,server_id,encrypted_verifier,expires_at)
		 values($1,$2,$3,$4,now()+interval '10 minutes')`,
		[stateHash(state), userId, serverId, await seal(verifier)],
	);
}

/** One-time: the state is consumed whether or not the exchange succeeds. */
export async function takeMcpOAuthState(userId: string, state: string) {
	const { rows } = await database().query<{
		server_id: string;
		encrypted_verifier: string;
	}>(
		"delete from mcp_oauth_state where state_hash=$1 and user_id=$2 and expires_at>now() returning server_id, encrypted_verifier",
		[stateHash(state), userId],
	);
	const row = rows[0];
	return row
		? {
				serverId: row.server_id,
				verifier: await unseal(row.encrypted_verifier),
			}
		: null;
}
