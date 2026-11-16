import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { otherRunningTurnOnMachine } from "./api-turns";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("./database", () => ({ database: () => holder.db }));

let db: PGlite;
const builder = randomUUID();
const reader = randomUUID();
const sharedWriter = randomUUID();
const forkedWriter = randomUUID();
const ownTurn = randomUUID();

beforeEach(async () => {
	db = new PGlite();
	holder.db = db;
	await db.exec(`create table agent_session(id uuid primary key,user_id text,provider_ref text,parent_session_id uuid,agent_role text,task_placement text);
	create table api_turn(id uuid primary key,session_id uuid,user_id text,state text);`);
	await db.query(
		`insert into agent_session(id,user_id,provider_ref,parent_session_id,agent_role,task_placement) values
		($1,'alice','vm-builder',null,null,null),
		($2,'alice',null,$1,'reviewer','shared'),
		($3,'alice',null,$1,'writer','shared'),
		($4,'alice','vm-fork',$1,'writer','fork')`,
		[builder, reader, sharedWriter, forkedWriter],
	);
	await db.query(
		`insert into api_turn(id,session_id,user_id,state) values($1,$2,'alice','running')`,
		[ownTurn, builder],
	);
});
afterEach(() => db.close());

const runTurn = (session: string, state = "running") =>
	db.query(
		`insert into api_turn(id,session_id,user_id,state) values($1,$2,'alice',$3)`,
		[randomUUID(), session, state],
	);

it("does not count the asking turn itself", async () => {
	expect(await otherRunningTurnOnMachine("alice", ownTurn, "vm-builder")).toBe(
		false,
	);
});

it("counts a reader or shared writer on the parent's VM", async () => {
	await runTurn(reader);
	expect(await otherRunningTurnOnMachine("alice", ownTurn, "vm-builder")).toBe(
		true,
	);
	await db.query("delete from api_turn where session_id=$1", [reader]);
	await runTurn(sharedWriter);
	expect(await otherRunningTurnOnMachine("alice", ownTurn, "vm-builder")).toBe(
		true,
	);
});

it("does not count a writer on its own fork, or turns that are not running", async () => {
	await runTurn(forkedWriter);
	await runTurn(reader, "completed");
	await runTurn(reader, "queued");
	expect(await otherRunningTurnOnMachine("alice", ownTurn, "vm-builder")).toBe(
		false,
	);
	// The fork's own turn is on the fork.
	expect(await otherRunningTurnOnMachine("alice", ownTurn, "vm-fork")).toBe(
		true,
	);
});

it("counts the builder's turn when a reader asks about the shared VM", async () => {
	const readerTurn = randomUUID();
	await db.query(
		`insert into api_turn(id,session_id,user_id,state) values($1,$2,'alice','running')`,
		[readerTurn, reader],
	);
	expect(
		await otherRunningTurnOnMachine("alice", readerTurn, "vm-builder"),
	).toBe(true);
});
