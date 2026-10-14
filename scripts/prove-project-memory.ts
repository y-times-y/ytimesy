import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { closeDatabase, database } from "#/server/adapters/database";
import {
	consolidateCloudProjectMemory,
	loadCloudProjectKnowledge,
	readCloudProjectMemory,
	readCloudProjectMemoryHistory,
	rememberCloudProjectKnowledge,
	searchCloudProjectMemory,
} from "#/server/services/project-knowledge";

const projectRef = "zqkptvyvoyqqtpihlshw";
const version = "20261005200000";
const name = "project_memory_revisions";
if (!process.argv.includes("--live"))
	throw new Error(
		"Explicit --live is required; no model inference or VMs are used.",
	);
const linked = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
const target = new URL(process.env.DATABASE_URL ?? "");
if (linked !== projectRef || !target.username.includes(projectRef))
	throw new Error("Not the approved development database.");
const projectId = randomUUID();
const workspaceId = randomUUID();
const sessionId = randomUUID();
let fixtureCreated = false;
try {
	if (process.argv.includes("--apply-migration")) {
		const client = await database().connect();
		try {
			await client.query("begin");
			await client.query("select pg_advisory_xact_lock(81738420)");
			const existing = await client.query(
				"select version from supabase_migrations.schema_migrations where version=$1",
				[version],
			);
			if (!existing.rowCount) {
				const sql = await readFile(
					`supabase/migrations/${version}_${name}.sql`,
					"utf8",
				);
				await client.query(sql);
				await client.query(
					"insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
					[version, name, [sql]],
				);
			}
			await client.query("commit");
			console.info("Development memory migration applied.");
		} catch {
			await client.query("rollback");
			throw new Error("Memory migration failed.");
		} finally {
			client.release();
		}
	}
	const owner = await database().query<{
		user_id: string;
		installation_id: string;
	}>("select user_id,installation_id from project order by created_at limit 1");
	if (!owner.rows[0])
		throw new Error(
			"An existing development owner is required; no users are minted.",
		);
	const { user_id: userId, installation_id: installationId } = owner.rows[0];
	await database().query(
		"insert into project(id,user_id,repository_id,installation_id,full_name,branch) values($1,$2,$3,$4,$5,'main')",
		[
			projectId,
			userId,
			8_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000),
			installationId,
			`memory-proof/${projectId}`,
		],
	);
	fixtureCreated = true;
	await database().query(
		"insert into workspace(id,user_id,project_id,status) values($1,$2,$3,'failed')",
		[workspaceId, userId, projectId],
	);
	await database().query(
		"insert into agent_session(id,user_id,project_id,workspace_id,harness,title,status) values($1,$2,$3,$4,'codex','Disposable memory proof','ready')",
		[sessionId, userId, projectId, workspaceId],
	);
	const session = {
		id: sessionId,
		userId,
		projectId,
		title: "Memory proof",
		parentSessionId: null,
	} as AgentSessionRecord;
	const entry = {
		key: "branches",
		title: "Branch routing",
		content: "Remember this source pointer across chats.",
		sources: ["src/branches.ts"],
		status: "observed" as const,
	};
	await rememberCloudProjectKnowledge(session, entry);
	const fresh = { ...session, title: "New chat" };
	assert.match(
		await loadCloudProjectKnowledge(fresh, "Fresh task"),
		/\[\[memory\/branches\]\]/,
	);
	const prior = await searchCloudProjectMemory(fresh, "branch");
	assert.equal(prior.total, 1);
	await rememberCloudProjectKnowledge(
		session,
		{ ...entry, key: "duplicate" },
		prior.revision,
	);
	await assert.rejects(
		rememberCloudProjectKnowledge(
			session,
			{ ...entry, content: "Stale write" },
			prior.revision,
		),
		/changed/,
	);
	const current = await searchCloudProjectMemory(fresh, "");
	await consolidateCloudProjectMemory(session, {
		expectedRevision: current.revision,
		entries: [{ ...entry, content: "Consolidated branch evidence" }],
		removeKeys: ["duplicate"],
	});
	assert.match(
		(await readCloudProjectMemory(fresh, "branches")).text ?? "",
		/Consolidated/,
	);
	assert.equal((await readCloudProjectMemory(fresh, "duplicate")).found, false);
	assert.equal(
		(await readCloudProjectMemoryHistory(fresh, "duplicate")).entries.length,
		2,
	);
	assert.equal(
		(
			await searchCloudProjectMemory(
				{ ...fresh, userId: "unauthorized-memory-proof" },
				"",
			)
		).total,
		0,
	);
	assert.equal(
		(
			await readCloudProjectMemoryHistory(
				{ ...fresh, userId: "unauthorized-memory-proof" },
				"branches",
			)
		).entries.length,
		0,
	);
	console.info(
		JSON.stringify({
			crossChatRead: true,
			history: true,
			consolidation: true,
			staleWriteRejected: true,
			ownerIsolation: true,
			inferenceRequests: 0,
			virtualMachines: 0,
		}),
	);
} catch {
	throw new Error(
		"Development memory proof failed; connection details and note contents are not logged.",
	);
} finally {
	try {
		if (fixtureCreated) {
			await database().query(
				"delete from project where id=$1 and full_name=$2",
				[projectId, `memory-proof/${projectId}`],
			);
			const remaining = await database().query(
				"select id from project where id=$1",
				[projectId],
			);
			assert.equal(remaining.rows.length, 0);
			console.info(
				"Disposable database fixtures and their memory revisions deleted; existing project notes untouched.",
			);
		}
	} finally {
		await closeDatabase();
	}
}
