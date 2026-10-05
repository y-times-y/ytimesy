import {
	completedTurnUpdatesProjectContext,
	relatedTracesForTask,
	traceAreaFromTurn,
	traceSummaryFromTurn,
} from "#/domain/project-context";
import {
	knowledgeForTask,
	type ProjectKnowledgeEntry,
	updateProjectKnowledge,
} from "#/domain/project-knowledge";
import {
	lastAgentMessageText,
	lastUserMessageText,
	type SessionItem,
} from "#/domain/session-item";
import { publicToolDetail } from "#/domain/tool-detail";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { database } from "../adapters/database";

export async function loadCloudProjectKnowledge(
	session: AgentSessionRecord,
	task: string,
): Promise<string> {
	const result = await database().query<{ text: string }>(
		`select b.text from project_briefing b join project p on p.id=b.project_id
		 where p.id=$1 and p.user_id=$2`,
		[session.projectId, session.userId],
	);
	const knowledge = knowledgeForTask(
		result.rows[0]?.text ?? "",
		task,
		Boolean(session.parentSessionId),
	);
	if (session.parentSessionId) return publicToolDetail(knowledge);
	const traces = await database().query<{
		area: string | null;
		summary: string;
	}>(
		`select t.area,t.summary from project_trace t join project p on p.id=t.project_id
		 join agent_session s on s.id=t.session_id
		 where p.id=$1 and p.user_id=$2 and s.user_id=$2 and s.parent_session_id is null and s.candidate_index is null
		 order by t.created_at desc limit 24`,
		[session.projectId, session.userId],
	);
	const reports = relatedTracesForTask(traces.rows, task, 4)
		.map((trace) => `- ${trace.area ?? "Project"}: ${trace.summary}`)
		.join("\n");
	return publicToolDetail(
		[
			knowledge,
			reports
				? `## Recent agent reports (not verified implementation facts)\n${reports}`
				: "",
		]
			.filter(Boolean)
			.join("\n\n"),
	);
}

/** Completion reports are separate from curated entries; failed and competing/child turns never publish shared facts. */
export async function recordCloudProjectReport(
	session: AgentSessionRecord,
	turnId: string,
	items: readonly SessionItem[],
): Promise<void> {
	if (
		session.parentSessionId ||
		(session.candidateIndex !== null && session.candidateIndex !== undefined)
	)
		return;
	const task = lastUserMessageText(items) ?? session.title;
	const reply = lastAgentMessageText(items) ?? "";
	const area = traceAreaFromTurn({ task, items });
	if (!completedTurnUpdatesProjectContext({ task, reply, area })) return;
	const summary = traceSummaryFromTurn({ task, reply });
	if (!summary) return;
	await database().query(
		`insert into project_trace(id,project_id,session_id,area,summary)
		 select $1,p.id,$3,$4,$5 from project p where p.id=$2 and p.user_id=$6
		 on conflict(id) do nothing`,
		[
			turnId,
			session.projectId,
			session.id,
			area,
			publicToolDetail(summary),
			session.userId,
		],
	);
}

/** Lock the project row even before its first knowledge entry; concurrent leads cannot overwrite one another. */
export async function rememberCloudProjectKnowledge(
	session: AgentSessionRecord,
	entry: ProjectKnowledgeEntry,
): Promise<{ saved: true; key: string }> {
	if (
		session.parentSessionId ||
		(session.candidateIndex !== null && session.candidateIndex !== undefined)
	)
		throw new Error(
			"Report discoveries to the lead; only non-competing leads maintain shared project knowledge.",
		);
	const client = await database().connect();
	try {
		await client.query("begin");
		const owned = await client.query(
			"select id from project where id=$1 and user_id=$2 for update",
			[session.projectId, session.userId],
		);
		if (!owned.rows.length) throw new Error("Project is not available.");
		const existing = await client.query<{ text: string }>(
			"select text from project_briefing where project_id=$1",
			[session.projectId],
		);
		const text = updateProjectKnowledge(existing.rows[0]?.text ?? "", {
			...entry,
			title: publicToolDetail(entry.title),
			content: publicToolDetail(entry.content),
			sources: entry.sources.map((source) => publicToolDetail(source)),
		});
		await client.query(
			`insert into project_briefing(project_id,text,updated_at) values($1,$2,now())
		 on conflict(project_id) do update set text=excluded.text,updated_at=now()`,
			[session.projectId, text],
		);
		await client.query("commit");
		return { saved: true, key: entry.key };
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
