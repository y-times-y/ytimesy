import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	recoverStaleQueuedWorkspaces,
	STALE_QUEUE_MESSAGE,
} from "./stale-workspace-queue";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../adapters/database", () => ({ database: () => holder.db }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	holder.db = db;
	await db.exec(`create table workspace(id uuid primary key,user_id text,status text,error_message text,template_snapshot_id text,updated_at timestamptz);
	create table environment_build(id uuid primary key,workspace_id uuid,status text);
	create table workspace_event(id uuid,workspace_id uuid,user_id text,message text);`);
});
afterEach(() => db.close());

it("fails only stale queued workspaces with no build and no template", async () => {
	const [stale, fresh, building, templated] = [
		randomUUID(),
		randomUUID(),
		randomUUID(),
		randomUUID(),
	];
	await db.query(
		`insert into workspace(id,user_id,status,template_snapshot_id,updated_at) values
		($1,'alice','queued',null,now()-interval '1 hour'),
		($2,'alice','queued',null,now()),
		($3,'alice','queued',null,now()-interval '1 hour'),
		($4,'alice','queued','snap',now()-interval '1 hour')`,
		[stale, fresh, building, templated],
	);
	await db.query(
		"insert into environment_build values($1,$2,'running')",
		[randomUUID(), building],
	);
	expect(await recoverStaleQueuedWorkspaces()).toBe(1);
	const rows = (
		await db.query<{ id: string; status: string; error_message: string }>(
			"select id,status,error_message from workspace",
		)
	).rows;
	expect(rows.find((row) => row.id === stale)).toMatchObject({
		status: "failed",
		error_message: STALE_QUEUE_MESSAGE,
	});
	expect(
		rows.filter((row) => row.id !== stale).map((row) => row.status),
	).toEqual(["queued", "queued", "queued"]);
	expect(
		(await db.query("select * from workspace_event")).rows,
	).toHaveLength(1);
});
