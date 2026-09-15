import { randomUUID } from "node:crypto";
import { database } from "./database";

export async function loadProjectBriefing(projectId: string) {
	const result = await database().query(
		"select text from project_briefing where project_id=$1",
		[projectId],
	);
	return typeof result.rows[0]?.text === "string" ? result.rows[0].text : "";
}

export async function saveProjectBriefing(projectId: string, text: string) {
	await database().query(
		`insert into project_briefing(project_id, text, updated_at)
		 values($1,$2,now())
		 on conflict(project_id) do update set text=excluded.text, updated_at=now()`,
		[projectId, text],
	);
}

export async function listProjectTraces(projectId: string, limit = 24) {
	const result = await database().query(
		`select area, summary from project_trace
		 where project_id=$1
		 order by created_at desc
		 limit $2`,
		[projectId, limit],
	);
	return result.rows as { area: string | null; summary: string }[];
}

export async function insertProjectTrace(input: {
	readonly projectId: string;
	readonly sessionId: string | null;
	readonly area: string | null;
	readonly summary: string;
}) {
	await database().query(
		`insert into project_trace(id, project_id, session_id, area, summary)
		 values($1,$2,$3,$4,$5)`,
		[
			randomUUID(),
			input.projectId,
			input.sessionId,
			input.area,
			input.summary,
		],
	);
}
