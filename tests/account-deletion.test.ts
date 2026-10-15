import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { accountDeletionConfirmed } from "../src/domain/account-deletion";
import { deleteAccount } from "../src/server/services/account-deletion";

let db: PGlite;
const storage = vi.hoisted(() => ({
	configured: vi.fn(() => true),
	remove: vi.fn(async (_user: string, _session: string) => {}),
}));
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params?: unknown[]) => db.query(sql, params),
		connect: async () => ({
			query: async (sql: string, params?: unknown[]) => {
				const result = await db.query(sql, params);
				return {
					...result,
					rowCount: result.rows.length || result.affectedRows,
				};
			},
			release() {},
		}),
	}),
}));
const memory = vi.hoisted(() => ({
	destroyed: [] as string[],
	fail: false,
}));
vi.mock("../src/server/adapters/memory-repos", () => ({
	memoryRepoName: (userId: string, override?: string | null) =>
		override || `memory-${userId}`,
	memoryRepo: (name: string) => ({
		destroy: async () => {
			if (memory.fail) throw new Error("Artifacts unavailable");
			memory.destroyed.push(name);
		},
	}),
}));
vi.mock("../src/server/adapters/checkpoints/storage", () => ({
	checkpointStorageConfigured: storage.configured,
	removeChatObjects: storage.remove,
}));

const project = "00000000-0000-4000-8000-000000000001";
const workspace = "00000000-0000-4000-8000-000000000002";
const session = "00000000-0000-4000-8000-000000000003";
const reservation = "00000000-0000-4000-8000-000000000004";

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());
beforeEach(async () => {
	vi.clearAllMocks();
	memory.destroyed.length = 0;
	memory.fail = false;
	await db.exec(`
		delete from infrastructure_provider_statement; delete from infrastructure_vm_admission; delete from infrastructure_usage_reservation;
		delete from auth_user;
		insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true);
		insert into auth_session(id,"expiresAt",token,"userId","updatedAt") values('s1',now()+interval '1 day','token','alice',now());
		insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('${project}','alice',1,1,'alice/app','main');
		insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id) values('${workspace}','alice','${project}','ready','vm-template','snap-template');
		insert into environment_build(id,workspace_id,status,input_hash,sources,snapshot_id,provider_ref) values(gen_random_uuid(),'${workspace}','ready','h','[]','snap-template','vm-build');
		insert into agent_session(id,user_id,project_id,workspace_id,harness,provider_ref,status) values('${session}','alice','${project}','${workspace}','codex','vm-chat','ready');
		insert into workspace_retention(session_id,user_id,vm_id,slug,resources,snapshot_id) values('${session}','alice','vm-chat','slug-chat','{}','snap-retained');
		insert into infrastructure_usage_reservation(id,user_id,resource_key,period,reserved_micro_usd) values('${reservation}','alice','vm:slug-chat',date_trunc('month',now())::date,500);
		insert into infrastructure_vm_admission(slug,user_id,reservation_id,max_run_total_seconds,baseline_seconds,hourly_micro_usd,vm_id) values('slug-chat','alice','${reservation}',60,0,1000,'vm-chat');
		insert into infrastructure_provider_statement(provider,account_id,source_id,period_start,period_end,statement,imported_by) values('freestyle','acct','src',now()-interval '1 month',now(),'{}','alice');
	`);
});

it("destroys the account's machines and snapshots, removes chat files and all rows", async () => {
	const machines = {
		destroy: vi.fn(async (_id: string) => {}),
		destroySnapshot: vi.fn(async (_id: string) => {}),
	};
	await deleteAccount(machines, "alice");
	expect(machines.destroy.mock.calls.map(([id]) => id).sort()).toEqual([
		"vm-build",
		"vm-chat",
		"vm-template",
	]);
	expect(machines.destroySnapshot.mock.calls.map(([id]) => id).sort()).toEqual([
		"snap-retained",
		"snap-template",
	]);
	expect(storage.remove).toHaveBeenCalledWith("alice", session);
	for (const table of [
		"auth_user",
		"auth_session",
		"project",
		"workspace",
		"agent_session",
		"workspace_retention",
		"infrastructure_vm_admission",
	]) {
		const rows = await db.query(
			`select 1 from ${table} where ${table === "auth_session" ? '"userId"' : table === "auth_user" ? "id" : "user_id"}='alice'`,
		);
		expect(rows.rows, table).toHaveLength(0);
	}
	expect((await db.query("select id from auth_user")).rows).toEqual([
		{ id: "bob" },
	]);
	const ledger = await db.query<{ consumed_micro_usd: string }>(
		"select consumed_micro_usd from infrastructure_usage_reservation",
	);
	expect(Number(ledger.rows[0].consumed_micro_usd)).toBe(500);
	const statement = await db.query<{ imported_by: string | null }>(
		"select imported_by from infrastructure_provider_statement",
	);
	expect(statement.rows[0].imported_by).toBeNull();
});

it("keeps going when a VM is already gone, but keeps everything if chat files cannot be removed", async () => {
	const machines = {
		destroy: vi.fn(async () => {
			throw new Error("gone");
		}),
		destroySnapshot: vi.fn(async (_id: string) => {}),
	};
	storage.remove.mockRejectedValueOnce(new Error("storage down"));
	const failure = await deleteAccount(machines, "alice").catch(
		(error: Response) => error,
	);
	expect(failure).toBeInstanceOf(Response);
	expect(
		(await db.query("select 1 from auth_user where id='alice'")).rows,
	).toHaveLength(1);
	await deleteAccount(machines, "alice");
	expect(
		(await db.query("select 1 from auth_user where id='alice'")).rows,
	).toHaveLength(0);
});

it("destroys no machine or snapshot until the account rows are gone", async () => {
	const accountAlive = async () =>
		(await db.query("select 1 from auth_user where id='alice'")).rows.length;
	const seenAlive: number[] = [];
	const machines = {
		destroy: vi.fn(async (_id: string) => {
			seenAlive.push(await accountAlive());
		}),
		destroySnapshot: vi.fn(async (_id: string) => {
			seenAlive.push(await accountAlive());
		}),
	};
	storage.remove.mockRejectedValueOnce(new Error("storage down"));
	await expect(deleteAccount(machines, "alice")).rejects.toBeInstanceOf(
		Response,
	);
	expect(machines.destroy).not.toHaveBeenCalled();
	expect(machines.destroySnapshot).not.toHaveBeenCalled();
	const template = await db.query<{ template_snapshot_id: string }>(
		`select template_snapshot_id from workspace where id='${workspace}'`,
	);
	expect(template.rows[0].template_snapshot_id).toBe("snap-template");

	await deleteAccount(machines, "alice");
	expect(seenAlive).toHaveLength(5);
	expect(seenAlive.every((alive) => alive === 0)).toBe(true);
});

it("reports success and logs leftovers when provider cleanup fails after the rows are deleted", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const machines = {
		destroy: vi.fn(async (_id: string) => {}),
		destroySnapshot: vi.fn(async (id: string) => {
			if (id === "snap-retained") throw new Error("provider down");
		}),
	};
	await deleteAccount(machines, "alice");
	expect(machines.destroySnapshot).toHaveBeenCalledTimes(2);
	expect(warn).toHaveBeenCalledWith(
		"Account deletion left provider resources to expire.",
		{ userId: "alice", leftovers: ["snapshot:snap-retained"] },
	);
	warn.mockRestore();
});

it("removes many chats' files with bounded concurrency", async () => {
	const values = Array.from(
		{ length: 20 },
		(_, index) =>
			`('00000000-0000-4000-8000-1000000000${String(index).padStart(2, "0")}','alice','${project}','${workspace}','codex','ready')`,
	).join(",");
	await db.exec(
		`insert into agent_session(id,user_id,project_id,workspace_id,harness,status) values ${values}`,
	);
	let inFlight = 0;
	let peak = 0;
	storage.remove.mockImplementation(async () => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 5));
		inFlight--;
	});
	await deleteAccount(
		{ destroy: vi.fn(async () => {}), destroySnapshot: vi.fn(async () => {}) },
		"alice",
	);
	expect(storage.remove).toHaveBeenCalledTimes(21);
	expect(peak).toBeGreaterThan(1);
	expect(peak).toBeLessThanOrEqual(6);
	storage.remove.mockImplementation(async () => {});
});

it("does not delete a snapshot another account still uses", async () => {
	await db.exec(`
		insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('00000000-0000-4000-8000-0000000000b1','bob',1,1,'bob/app','main');
		insert into workspace(id,user_id,project_id,status,template_snapshot_id) values('00000000-0000-4000-8000-0000000000b2','bob','00000000-0000-4000-8000-0000000000b1','ready','snap-template');
	`);
	const machines = {
		destroy: vi.fn(async (_id: string) => {}),
		destroySnapshot: vi.fn(async (_id: string) => {}),
	};
	await deleteAccount(machines, "alice");
	expect(machines.destroySnapshot.mock.calls.map(([id]) => id)).toEqual([
		"snap-retained",
	]);
});

it("requires the typed confirmation to match the account email", () => {
	expect(
		accountDeletionConfirmed(
			{ email: "Alice@Example.test" },
			" alice@example.test ",
		),
	).toBe(true);
	expect(
		accountDeletionConfirmed({ email: "alice@example.test" }, "alice"),
	).toBe(false);
	expect(accountDeletionConfirmed({ email: null }, "delete my account")).toBe(
		true,
	);
});

it("deletes the user's memory repos, and only logs when Artifacts fails", async () => {
	const machines = {
		destroy: vi.fn(async (_id: string) => {}),
		destroySnapshot: vi.fn(async (_id: string) => {}),
	};
	await db.exec(
		"insert into user_memory(user_id,mode,repo) values('alice','full','memory-eval-alice')",
	);
	await deleteAccount(machines, "alice");
	expect(memory.destroyed.sort()).toEqual([
		"memory-alice",
		"memory-eval-alice",
	]);

	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('carol','Carol','carol@example.test',true)`,
	);
	memory.fail = true;
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await deleteAccount(machines, "carol");
	expect(warn).toHaveBeenCalledWith(
		"Account deletion left provider resources to expire.",
		expect.objectContaining({ leftovers: ["memory:memory-carol"] }),
	);
	warn.mockRestore();
});
