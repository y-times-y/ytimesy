import { randomUUID } from "node:crypto";
import type { AgentProviderId } from "#/domain/agent-provider";
import { database } from "./database";

const SESSION_COLUMNS =
	"id,user_id,project_id,workspace_id,harness,provider_ref,parent_session_id,title,briefing,items,listed_model_id,status,updated_at";

export type AgentSessionRecord = {
	id: string;
	userId: string;
	projectId: string;
	workspaceId: string;
	harness: AgentProviderId;
	providerRef: string | null;
	parentSessionId: string | null;
	title: string;
	briefing: string | null;
	items: unknown;
	listedModelId: string | null;
	status: "starting" | "ready" | "failed";
	updatedAt: string;
};

interface AgentSessionRow {
	id: string;
	user_id: string;
	project_id: string;
	workspace_id: string;
	harness: AgentProviderId;
	provider_ref: string | null;
	parent_session_id: string | null;
	title: string;
	briefing: string | null;
	items: unknown;
	listed_model_id: string | null;
	status: AgentSessionRecord["status"];
	updated_at: Date | string;
}

export async function listAgentSessions(userId: string, projectId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS}
		 from agent_session
		 where user_id=$1 and project_id=$2 and parent_session_id is null
		 order by updated_at desc`,
		[userId, projectId],
	);
	return result.rows.map((row: AgentSessionRow) => toSession(row));
}

export async function agentSessionForOwner(userId: string, sessionId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS} from agent_session where id=$1 and user_id=$2`,
		[sessionId, userId],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function childAgentSession(
	userId: string,
	parentSessionId: string,
) {
	const children = await childAgentSessions(userId, parentSessionId);
	return children[0] ?? null;
}

export async function childAgentSessions(
	userId: string,
	parentSessionId: string,
) {
	const result = await database().query(
		`select ${SESSION_COLUMNS}
		 from agent_session
		 where user_id=$1 and parent_session_id=$2
		 order by created_at asc`,
		[userId, parentSessionId],
	);
	return result.rows.map((row: AgentSessionRow) => toSession(row));
}

export async function deleteAgentSessionForOwner(
	userId: string,
	sessionId: string,
) {
	await database().query(
		`delete from agent_session where id=$1 and user_id=$2`,
		[sessionId, userId],
	);
}

export async function insertAgentSession(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly harness: AgentProviderId;
	readonly providerRef?: string | null;
	readonly parentSessionId?: string | null;
	readonly title?: string;
	readonly listedModelId?: string | null;
}) {
	const id = randomUUID();
	const result = await database().query(
		`insert into agent_session(id,user_id,project_id,workspace_id,harness,provider_ref,parent_session_id,title,listed_model_id,status)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,'starting')
		 returning ${SESSION_COLUMNS}`,
		[
			id,
			input.userId,
			input.projectId,
			input.workspaceId,
			input.harness,
			input.providerRef ?? null,
			input.parentSessionId ?? null,
			input.title ?? (input.parentSessionId ? "Side chat" : "New session"),
			input.listedModelId?.trim() || null,
		],
	);
	return toSession(result.rows[0]);
}

export async function saveAgentSessionProviderRef(
	sessionId: string,
	providerRef: string,
) {
	const result = await database().query(
		`update agent_session set provider_ref=$2, status='ready', updated_at=now()
		 where id=$1
		 returning ${SESSION_COLUMNS}`,
		[sessionId, providerRef],
	);
	return toSession(result.rows[0]);
}

export async function saveAgentSessionItems(
	sessionId: string,
	items: unknown,
	title?: string,
	listedModelId?: string | null,
) {
	const result = await database().query(
		`update agent_session
		 set items=$2::jsonb,
		     title=coalesce($3, title),
		     listed_model_id=coalesce($4, listed_model_id),
		     updated_at=now()
		 where id=$1
		 returning ${SESSION_COLUMNS}`,
		[
			sessionId,
			JSON.stringify(items),
			title ?? null,
			listedModelId?.trim() || null,
		],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function templateAlreadyBound(
	workspaceId: string,
	templateProviderRef: string,
) {
	const result = await database().query(
		`select 1 from agent_session
		 where workspace_id=$1 and provider_ref=$2
		 limit 1`,
		[workspaceId, templateProviderRef],
	);
	return Boolean(result.rowCount);
}

function toSession(row: AgentSessionRow): AgentSessionRecord {
	return {
		id: row.id,
		userId: row.user_id,
		projectId: row.project_id,
		workspaceId: row.workspace_id,
		harness: row.harness,
		providerRef: row.provider_ref,
		parentSessionId: row.parent_session_id,
		title: row.title,
		briefing: row.briefing,
		items: row.items,
		listedModelId: row.listed_model_id,
		status: row.status,
		updatedAt:
			row.updated_at instanceof Date
				? row.updated_at.toISOString()
				: String(row.updated_at),
	};
}
