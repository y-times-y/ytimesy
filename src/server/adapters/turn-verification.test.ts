import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompletedVerification } from "#/domain/completion-verification";
import { acceptTaskPatch } from "./task-patch-evidence";
import {
	findCompletedVerification,
	pinVerificationBaseline,
	readVerificationBaseline,
	recordCompletedVerification,
} from "./turn-verification";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
let db: PGlite;
const parent = randomUUID(),
	task = randomUUID();
const receipt: CompletedVerification = {
	type: "completion-verification",
	directory: "/repo",
	turn: "a".repeat(64),
	base: "b".repeat(40),
	tree: "c".repeat(40),
	patchSha256: "d".repeat(64),
	checks: [
		{
			command: "npm test",
			reference: randomUUID(),
			exitCode: 0,
			stopped: null,
		},
	],
};
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,parent_session_id uuid,task_state text,task_review_state text,updated_at timestamptz default now());
	create table agent_task_command_receipt(parent_session_id uuid references agent_session(id),request_id text,status text,response jsonb,completed_at timestamptz,updated_at timestamptz default now(),primary key(parent_session_id,request_id));`);
	await db.query(
		"insert into agent_session(id,user_id,parent_session_id,task_state) values($1,'alice',null,null),($2,'alice',$1,'done')",
		[parent, task],
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows ?? result.rows.length };
	});
});
afterEach(async () => {
	await db.close();
});

it("pins immutable owner-scoped baselines rather than accepting a later guest redefinition", async () => {
	await pinVerificationBaseline("alice", task, "/repo", receipt.base);
	expect(await readVerificationBaseline("alice", task, "/repo")).toBe(
		receipt.base,
	);
	expect(await readVerificationBaseline("bob", task, "/repo")).toBeNull();
	await expect(
		pinVerificationBaseline("alice", task, "/repo", "e".repeat(40)),
	).rejects.toThrow("changed");
	expect(await readVerificationBaseline("alice", task, "/repo")).toBe(
		receipt.base,
	);
});

it("retains and finds only this owner's exact whole-tree receipt", async () => {
	await expect(
		recordCompletedVerification("bob", task, receipt),
	).rejects.toThrow("no longer available");
	await recordCompletedVerification("alice", task, receipt);
	expect(
		await findCompletedVerification("alice", task, "/repo", receipt),
	).toEqual(receipt);
	expect(
		await findCompletedVerification("alice", task, "/repo", {
			base: receipt.base,
			patchSha256: receipt.patchSha256,
		}),
	).toEqual(receipt);
	expect(
		await findCompletedVerification("alice", task, "/repo", {
			base: receipt.base,
			patchSha256: "f".repeat(64),
		}),
	).toBeNull();
	expect(
		await findCompletedVerification("bob", task, "/repo", receipt),
	).toBeNull();
	expect(
		await findCompletedVerification("alice", task, "/repo", {
			...receipt,
			tree: "e".repeat(40),
		}),
	).toBeNull();
	expect(
		await findCompletedVerification("alice", task, "/other", receipt),
	).toBeNull();
});

it("atomically rejects legacy manual acceptance and stale or cross-owner evidence", async () => {
	const patch = {
		taskId: task,
		sha256: receipt.patchSha256,
		base: receipt.base,
	};
	await expect(acceptTaskPatch("alice", parent, patch)).rejects.toThrow(
		"lacks authoritative",
	);
	await recordCompletedVerification("alice", task, receipt);
	await expect(
		acceptTaskPatch("alice", parent, { ...patch, sha256: "f".repeat(64) }),
	).rejects.toThrow();
	await expect(acceptTaskPatch("bob", parent, patch)).rejects.toThrow();
	await acceptTaskPatch("alice", parent, patch);
	expect(
		(
			await db.query(
				"select task_review_state from agent_session where id=$1",
				[task],
			)
		).rows,
	).toEqual([{ task_review_state: "reviewed" }]);
});

it("rejects empty, stopped or failed check evidence before storage", async () => {
	for (const invalid of [
		{ ...receipt, checks: [] },
		{ ...receipt, checks: [{ ...receipt.checks[0], exitCode: 1 }] },
		{ ...receipt, checks: [{ ...receipt.checks[0], stopped: "timeout" }] },
	])
		await expect(
			recordCompletedVerification(
				"alice",
				task,
				invalid as CompletedVerification,
			),
		).rejects.toThrow();
	expect(
		(await db.query("select * from agent_task_command_receipt")).rows,
	).toHaveLength(0);
});
