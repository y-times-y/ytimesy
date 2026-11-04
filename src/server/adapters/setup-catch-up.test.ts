import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshMachineNotice } from "#/domain/fresh-machine-setup";
import { injectServerPeerMessages } from "./server-peer-inbox";
import {
	finishSetupCatchUp,
	markFreshChatMachine,
	readySetupCatchUps,
	takeFreshInstallStart,
	takeSetupCatchUp,
} from "./setup-catch-up";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const project = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,project_id uuid);
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function chat(projectId = project) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id) values($1,'alice',$2)",
		[id, projectId],
	);
	return id;
}

const pending = async (sessionId: string) =>
	(
		await db.query(
			"select 1 from agent_peer_inbox where recipient_id=$1 and not accepted",
			[sessionId],
		)
	).rows.length;

it("a fresh machine's agent gets one notice; its catch-up stays out of the inbox until setup is saved", async () => {
	const task = await chat();
	await markFreshChatMachine(task);
	await markFreshChatMachine(task);
	const ready = vi.fn();
	const delivered = await injectServerPeerMessages(
		task,
		[],
		async () => {},
		undefined,
		ready,
	);
	expect(delivered).toEqual([{ role: "user", content: freshMachineNotice() }]);
	expect(ready).not.toHaveBeenCalled();
	// Only the catch-up's dormant row is left, invisible to the heartbeat.
	expect(await pending(task)).toBe(0);
	expect(await takeSetupCatchUp(task)).toBe(false);
});

it("starts a fresh machine's install once", async () => {
	const task = await chat();
	expect(await takeFreshInstallStart(task)).toBe(false);
	await markFreshChatMachine(task);
	expect(await takeFreshInstallStart(task)).toBe(true);
	expect(await takeFreshInstallStart(task)).toBe(false);
});

it("readies every fresh chat of the project but the one that saved, and each catches up once", async () => {
	const [task, started, saver, other, templated] = [
		await chat(),
		await chat(),
		await chat(),
		await chat(randomUUID()),
		await chat(),
	];
	for (const id of [task, started, saver, other])
		await markFreshChatMachine(id);
	await injectServerPeerMessages(task, [], async () => {});
	await takeFreshInstallStart(started);
	const readied = await readySetupCatchUps({
		userId: "alice",
		projectId: project,
		savedInSessionId: saver,
	});
	// Not the saver, not another project's chat, not a chat copied from the template.
	expect(new Set(readied)).toEqual(new Set([task, started]));
	expect(readied).not.toContain(templated);
	// The heartbeat now sees it; the step's inbox read reports it, never injects it.
	expect(await pending(task)).toBe(1);
	const ready = vi.fn();
	expect(
		await injectServerPeerMessages(task, [], async () => {}, undefined, ready),
	).toEqual([]);
	expect(ready).toHaveBeenCalledOnce();
	expect(await takeSetupCatchUp(saver)).toBe(false);
	expect(await takeSetupCatchUp(other)).toBe(false);
	expect(await takeSetupCatchUp(task)).toBe(true);
	expect(await takeSetupCatchUp(task)).toBe(false);
	expect(await pending(task)).toBe(0);
	await finishSetupCatchUp(task);
	// A second save readies nothing again; a chat still to catch up catches up once.
	expect(
		await readySetupCatchUps({ userId: "alice", projectId: project }),
	).toEqual([]);
	expect(await takeSetupCatchUp(started)).toBe(true);
	expect(
		(
			await db.query(
				"select 1 from agent_peer_inbox where recipient_id=$1 and id like 'setup-catch-up:%'",
				[task],
			)
		).rows,
	).toEqual([]);
});
