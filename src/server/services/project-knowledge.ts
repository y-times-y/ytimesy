import { createHash, randomUUID } from "node:crypto";
import {
	completedTurnUpdatesProjectContext,
	relatedTracesForTask,
	traceAreaFromTurn,
	traceSummaryFromTurn,
} from "#/domain/project-context";
import {
	knowledgeForTask,
	type ProjectKnowledgeEntry,
	projectKnowledgeSections,
	projectMemoryMaintenance,
	searchProjectKnowledge,
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

const memoryRevision = (text: string) =>
	createHash("sha256").update(text).digest("hex");

export async function loadCloudProjectMemoryDocument(
	session: AgentSessionRecord,
) {
	const result = await database().query<{ text: string }>(
		`select b.text from project_briefing b join project p on p.id=b.project_id
		 where p.id=$1 and p.user_id=$2`,
		[session.projectId, session.userId],
	);
	return result.rows[0]?.text ?? "";
}

export async function searchCloudProjectMemory(
	session: AgentSessionRecord,
	query: string,
	offset = 0,
) {
	const document = await loadCloudProjectMemoryDocument(session);
	const entries = query.trim()
		? searchProjectKnowledge(document, query)
		: projectKnowledgeSections(document);
	return {
		revision: memoryRevision(document),
		maintenance: projectMemoryMaintenance(document),
		total: entries.length,
		nextOffset: offset + 12 < entries.length ? offset + 12 : null,
		entries: entries.slice(offset, offset + 12).map((entry) => ({
			key: entry.key,
			title: entry.title,
			reference: `memory/${entry.key}`,
			excerpt: publicToolDetail(entry.text).slice(0, 500),
		})),
	};
}

export async function readCloudProjectMemory(
	session: AgentSessionRecord,
	key: string,
) {
	const document = await loadCloudProjectMemoryDocument(session);
	const entry = projectKnowledgeSections(document).find(
		(entry) => entry.key === key,
	);
	return {
		revision: memoryRevision(document),
		key,
		found: Boolean(entry),
		text: entry ? publicToolDetail(entry.text) : null,
	};
}

export async function readCloudProjectMemoryHistory(
	session: AgentSessionRecord,
	key: string,
	offset = 0,
	revisionId?: string,
) {
	const result = await database().query<{
		id: string;
		previous_text: string;
		next_text: string;
		operation: string;
		created_at: Date;
		session_id: string | null;
		document_revision: string;
	}>(
		`select r.id,r.previous_text,r.next_text,r.operation,r.created_at,r.session_id,r.document_revision from project_memory_revision r
		 join project p on p.id=r.project_id where p.id=$1 and p.user_id=$2 and r.memory_key=$3 and ($5::uuid is null or r.id=$5)
		 order by r.created_at desc,r.id desc limit 6 offset $4`,
		[session.projectId, session.userId, key, offset, revisionId ?? null],
	);
	return {
		nextOffset: result.rows.length > 5 ? offset + 5 : null,
		entries: result.rows.slice(0, 5).map((row) => ({
			id: row.id,
			operation: row.operation,
			createdAt: row.created_at,
			sessionId: row.session_id,
			documentRevision: row.document_revision,
			previous: publicToolDetail(row.previous_text).slice(
				0,
				revisionId ? 16000 : 600,
			),
			next: publicToolDetail(row.next_text).slice(0, revisionId ? 16000 : 600),
			abbreviated:
				!revisionId &&
				(row.previous_text.length > 600 || row.next_text.length > 600),
		})),
	};
}

export async function loadCloudProjectKnowledge(
	session: AgentSessionRecord,
	task: string,
): Promise<string> {
	const document = await loadCloudProjectMemoryDocument(session);
	const knowledge = knowledgeForTask(
		document,
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
		 where p.id=$1 and p.user_id=$2 and s.user_id=$2 and s.parent_session_id is null
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

/** Completion reports are separate from curated entries; failed and child turns never publish shared facts. */
export async function recordCloudProjectReport(
	session: AgentSessionRecord,
	turnId: string,
	items: readonly SessionItem[],
): Promise<void> {
	if (session.parentSessionId) return;
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
	expectedRevision?: string,
): Promise<{ saved: true; key: string; revision: string }> {
	const revision = await changeCloudProjectMemory(session, {
		entries: [entry],
		removeKeys: [],
		expectedRevision,
		operation: "remember",
	});
	return { saved: true, key: entry.key, revision };
}

/** Atomic replacement/removal with a document fence; an agent cannot consolidate a stale read. */
export async function consolidateCloudProjectMemory(
	session: AgentSessionRecord,
	input: {
		entries: ProjectKnowledgeEntry[];
		removeKeys: string[];
		expectedRevision: string;
	},
) {
	const revision = await changeCloudProjectMemory(session, {
		...input,
		operation: "consolidate",
	});
	return {
		saved: true,
		updatedKeys: input.entries.map((entry) => entry.key),
		removedKeys: input.removeKeys,
		revision,
	};
}

async function changeCloudProjectMemory(
	session: AgentSessionRecord,
	input: {
		entries: ProjectKnowledgeEntry[];
		removeKeys: string[];
		expectedRevision?: string;
		operation: "remember" | "consolidate";
	},
) {
	if (session.parentSessionId)
		throw new Error(
			"Report discoveries to the lead; only root chats maintain shared project knowledge.",
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
		const previous = existing.rows[0]?.text ?? "";
		if (
			input.expectedRevision !== undefined &&
			memoryRevision(previous) !== input.expectedRevision
		)
			throw new Error(
				"Project memory changed. Read it again before updating or consolidating.",
			);
		const keys = [
			...input.entries.map((entry) => entry.key),
			...input.removeKeys,
		];
		if (
			!keys.length ||
			keys.length > 16 ||
			new Set(keys).size !== keys.length ||
			keys.some((key) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(key))
		)
			throw new Error(
				"Use distinct memory keys, at most sixteen changes per consolidation.",
			);
		let text = previous;
		for (const key of input.removeKeys) {
			const section = projectKnowledgeSections(text).find(
				(entry) => entry.key === key,
			);
			if (!section) throw new Error("Memory to remove no longer exists.");
			text = text.replace(section.text, "").trim();
		}
		for (const entry of input.entries)
			text = updateProjectKnowledge(text, {
				...entry,
				title: publicToolDetail(entry.title),
				content: publicToolDetail(entry.content),
				sources: entry.sources.map((source) => publicToolDetail(source)),
			});
		for (const key of input.removeKeys) {
			if (text.includes(`[[memory/${key}]]`))
				throw new Error(
					"Update linked notes before removing their target topic.",
				);
		}
		for (const key of keys) {
			const before =
				projectKnowledgeSections(previous).find((entry) => entry.key === key)
					?.text ?? "";
			const after =
				projectKnowledgeSections(text).find((entry) => entry.key === key)
					?.text ?? "";
			if (before === after) continue;
			await client.query(
				`insert into project_memory_revision(id,project_id,session_id,memory_key,document_revision,operation,previous_text,next_text)
			 values($1,$2,$3,$4,$5,$6,$7,$8)`,
				[
					randomUUID(),
					session.projectId,
					session.id,
					key,
					memoryRevision(text),
					input.operation,
					publicToolDetail(before),
					publicToolDetail(after),
				],
			);
		}
		await client.query(
			`insert into project_briefing(project_id,text,updated_at) values($1,$2,now())
		 on conflict(project_id) do update set text=excluded.text,updated_at=now()`,
			[session.projectId, text],
		);
		await client.query("commit");
		return memoryRevision(text);
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
