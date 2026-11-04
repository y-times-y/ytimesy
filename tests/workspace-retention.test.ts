import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { type Freestyle, FreestyleApiError } from "freestyle";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { snapshotSupportsRetention } from "../src/domain/workspace-retention";
import { SCRUB_WORKSPACE_SECRETS } from "../src/server/adapters/freestyle/scrub-agent-secrets";
import {
	expireRetainedWorkspace,
	RecycleDeferred,
	rebindWorkspaceRetention,
	recycleIdleWorkspaces,
	recycleWorkspace,
	restoreRetainedWorkspace,
	retainedTreeDigest,
	touchWorkspaceRetention,
} from "../src/server/adapters/freestyle/workspace-retention";

let db: PGlite;
const query = async (sql: string, params: unknown[] = []) => {
	const result = await db.query(sql, params);
	return {
		...result,
		rowCount: result.rows.length || result.affectedRows || 0,
	};
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: async () => ({
		id: "project",
		fullName: "owner/repo",
		branch: "main",
		repositoryId: 1,
		installationId: 1,
	}),
}));
const session = "00000000-0000-4000-8000-000000000001";
const resources = { cpu: 2, memory: 4096, storage: 16384 };
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values('alice');
	create table agent_session(id uuid primary key,user_id text,project_id text,provider_ref text,turn_status text,task_placement text,agent_role text);
	create table api_turn(session_id uuid,state text); create table workspace(id text,user_id text); create table environment_build(id text,workspace_id text);`);
	for (const file of [
		"20261003020000_infrastructure_usage",
		"20261003021000_infrastructure_vm_identity",
		"20261003022000_workspace_retention",
		"20261003024000_infrastructure_zero_runtime",
		"20261013060000_infrastructure_vm_lease",
		"20261020130000_infrastructure_usage_windows",
		"20261026120000_infrastructure_usage_total",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
});
beforeEach(async () => {
	vi.stubEnv("YTIMESY_WORKSPACE_RETENTION", "true");
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "true");
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "66120");
	vi.stubEnv("YTIMESY_USER_WEEKLY_MICRO_USD", "66120");
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "500000000");
	vi.stubEnv("YTIMESY_FLEET_LIFETIME_MICRO_USD", "7000000000");
	await db.exec(
		"truncate workspace_retention,infrastructure_vm_lease,infrastructure_vm_admission,infrastructure_usage_reservation,agent_session,api_turn;",
	);
	await query(
		"insert into agent_session values($1,'alice','project','source','completed','fresh')",
		[session],
	);
	await query(
		"insert into workspace_retention(session_id,user_id,vm_id,slug,resources,last_activity_at) values($1,'alice','source','ytimesy-ag-0000000000004000',$2,now()-interval '2 hours')",
		[session, JSON.stringify(resources)],
	);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await db.close();
});
const DIGEST = `ytimesy-tree-v2 2 6 ${"a".repeat(64)}\n`;
function provider(
	options: {
		public?: boolean;
		mismatch?: boolean;
		recent?: boolean;
		/** Activity the provider reports only after the window resumes the VM. */
		lateActivity?: string;
	} = {},
) {
	let sourceCap = 300;
	let sourceState = "paused";
	let sourceRun = 20;
	let activity = options.recent ? new Date().toISOString() : "2026-01-01";
	const source = {
		data: async () => ({
			id: "source",
			slug: "ytimesy-ag-0000000000004000",
			state: sourceState,
			resources,
			totalRunSeconds: sourceRun,
			maxRunTotalSeconds: sourceCap,
			createdAt: "2026-01-01",
			lastNetworkActivity: activity,
		}),
		update: vi.fn(async (input: { maxRunTotalSeconds: number }) => {
			sourceCap = input.maxRunTotalSeconds;
		}),
		// Like Freestyle: exec resumes a paused VM, and a VM at its runtime cap refuses.
		exec: vi.fn(
			async (input: {
				command: string;
			}): Promise<{ statusCode: number | null; stdout?: string }> => {
				if (sourceRun >= sourceCap)
					throw new FreestyleApiError(
						409,
						{ code: "CONFLICT", message: "used its total runtime budget" },
						"/v5/vms/source/exec-await",
					);
				sourceState = "running";
				sourceRun += 1;
				// Resuming stamps network activity, as Freestyle does.
				activity = options.lateActivity ?? new Date().toISOString();
				return {
					statusCode: 0,
					stdout: input.command.includes("ytimesy-tree-v2") ? DIGEST : "",
				};
			},
		),
		pause: vi.fn(async () => {
			sourceState = "paused";
		}),
		snapshot: vi.fn(async () => ({ snapshotId: "snapshot" })),
		delete: vi.fn(async () => {}),
	};
	const verification = {
		exec: vi.fn(async () => ({
			statusCode: 0,
			stdout: options.mismatch
				? `ytimesy-tree-v2 2 6 ${"b".repeat(64)}\n`
				: DIGEST,
		})),
		pause: vi.fn(async () => {}),
		data: async () => ({ state: "paused", resources, totalRunSeconds: 1 }),
		delete: vi.fn(async () => {}),
	};
	const client = {
		vms: {
			ref: () => source,
			create: vi.fn(async () => ({ vm: verification, vmId: "verification" })),
			snapshots: {
				get: async () => ({
					id: "snapshot",
					public: options.public ?? false,
					sourceVmId: "source",
					createdAt: new Date().toISOString(),
				}),
				delete: vi.fn(async () => {}),
			},
		},
	};
	return { client: client as unknown as Freestyle, source, verification };
}
it("requires private source identity and an effective full recovery window", () => {
	const base = {
		public: false,
		sourceVmId: "source",
		expectedSourceVmId: "source",
		createdAt: "2026-01-01",
		expiresAt: Date.parse("2026-04-01"),
	};
	expect(snapshotSupportsRetention(base)).toBe(true);
	expect(snapshotSupportsRetention({ ...base, public: true })).toBe(false);
	expect(snapshotSupportsRetention({ ...base, sourceVmId: "other" })).toBe(
		false,
	);
	expect(
		snapshotSupportsRetention({ ...base, autoDeleteSeconds: 30 * 86400 }),
	).toBe(false);
	expect(snapshotSupportsRetention({ ...base, ttlSeconds: 30 * 86400 })).toBe(
		false,
	);
});
it("persists verified recovery BEFORE source deletion and includes ignored files", async () => {
	const { client, source, verification } = provider();
	source.delete.mockImplementation(async () => {
		expect(
			(await query("select phase,snapshot_id from workspace_retention"))
				.rows[0],
		).toMatchObject({ phase: "retained", snapshot_id: "snapshot" });
	});
	await recycleWorkspace(client, session);
	expect(source.delete).toHaveBeenCalledOnce();
	expect(verification.delete).toHaveBeenCalledOnce();
	// Project secrets are removed before the image is taken.
	expect(source.exec).toHaveBeenCalledWith(
		expect.objectContaining({ command: SCRUB_WORKSPACE_SECRETS }),
	);
	expect(source.exec.mock.invocationCallOrder[0]).toBeLessThan(
		source.snapshot.mock.invocationCallOrder[0] ?? 0,
	);
	expect(client.vms.create).toHaveBeenCalledWith(
		expect.objectContaining({
			firewall: { rules: [] },
			maxRunTotalSeconds: 45,
			automaticRestart: false,
		}),
	);
});
it("runs the fenced source only inside a capped window, then re-fences it at its runtime", async () => {
	const { client, source, verification } = provider();
	await recycleWorkspace(client, session);
	// Fence at 20s, open the window to 20+120s, close it at the 22s used.
	expect(
		source.update.mock.calls.map(([input]) => input.maxRunTotalSeconds),
	).toEqual([20, 140, 22]);
	expect(source.pause).toHaveBeenCalled();
	expect(source.pause.mock.invocationCallOrder[0]).toBeLessThan(
		source.snapshot.mock.invocationCallOrder[0] ?? 0,
	);
	// Both digests run the same single command as root with a time bound.
	const sourceDigest = source.exec.mock.calls[1][0] as unknown as {
		command: string;
		linuxUser: string;
		timeoutMs: number;
	};
	expect(sourceDigest).toMatchObject({ linuxUser: "root", timeoutMs: 20_000 });
	expect(verification.exec).toHaveBeenCalledWith(sourceDigest);
	// Maintenance never reserves against the user's allowance.
	const holds = await query(
		"select resource_key from infrastructure_usage_reservation where resource_key like 'recovery-%'",
	);
	expect(holds.rows).toEqual([]);
});
it("moves the VM's own admission past the capture window it paid for, so a later wake never counts it twice", async () => {
	// The VM's admission, settled at its own 20 s before recycling ran it.
	await query(
		"insert into infrastructure_usage_reservation(id,user_id,resource_key,period,reserved_micro_usd,consumed_micro_usd,settled_at) values('30000000-0000-4000-8000-0000000000aa','alice','vm:source',date_trunc('month',now()),1000,500,now())",
	);
	await query(
		"insert into infrastructure_vm_admission(slug,vm_id,user_id,reservation_id,max_run_total_seconds,baseline_seconds,hourly_micro_usd) values('ytimesy-ag-0000000000004000','source','alice','30000000-0000-4000-8000-0000000000aa',20,0,1000)",
	);
	const { client } = provider();
	await recycleWorkspace(client, session);
	// The window ran 20 -> 22 s: those 2 s are the capture hold's, not the VM's.
	const admission = await query(
		"select baseline_seconds::int as baseline,max_run_total_seconds::int as cap from infrastructure_vm_admission where vm_id='source'",
	);
	expect(admission.rows).toEqual([{ baseline: 2, cap: 22 }]);
});
it("treats activity from its own capture window as idle, but not earlier activity", async () => {
	// The default mock stamps activity "now" on every exec: still recycled.
	const own = provider();
	await recycleWorkspace(own.client, session);
	expect(own.source.delete).toHaveBeenCalledOnce();
	// Activity from before the fence, reported late, still defers.
	await query(
		"update workspace_retention set phase='active',snapshot_id=null,retry_after=now()",
	);
	const late = provider({
		lateActivity: new Date(Date.now() - 10 * 60_000).toISOString(),
	});
	await expect(recycleWorkspace(late.client, session)).rejects.toThrow(
		"recent interactive activity",
	);
	expect(late.source.snapshot).not.toHaveBeenCalled();
	expect(late.source.delete).not.toHaveBeenCalled();
});
it("re-fences the source even when its digest fails", async () => {
	const { client, source } = provider();
	source.exec.mockImplementationOnce(async () => ({ statusCode: 0 }));
	source.exec.mockImplementationOnce(async () => ({ statusCode: 64 }));
	await expect(recycleWorkspace(client, session)).rejects.toThrow(
		"symlinked project root",
	);
	expect(source.update.mock.calls.at(-1)?.[0].maxRunTotalSeconds).toBe(20);
	expect(source.snapshot).not.toHaveBeenCalled();
	expect(source.delete).not.toHaveBeenCalled();
});
it("defers, not alerts, when the restored tree differs, and removes the snapshot", async () => {
	const { client, source } = provider({ mismatch: true });
	const failure = await recycleWorkspace(client, session).catch((e) => e);
	expect(failure).toBeInstanceOf(RecycleDeferred);
	expect(failure.category).toBe("mismatch");
	expect(source.delete).not.toHaveBeenCalled();
	expect(client.vms.snapshots.delete).toHaveBeenCalledWith("snapshot");
	expect(
		(await query("select phase,snapshot_id from workspace_retention")).rows[0],
	).toMatchObject({ phase: "active", snapshot_id: null });
});
it.each([{ public: true }, { mismatch: true }, { recent: true }])(
	"never deletes the source after failed verification %j",
	async (options) => {
		const { client, source } = provider(options);
		await expect(recycleWorkspace(client, session)).rejects.toThrow();
		expect(source.delete).not.toHaveBeenCalled();
		expect(
			(await query("select phase from workspace_retention")).rows[0],
		).toMatchObject({ phase: "active" });
	},
);
it("blocks queued shared-child work before touching the provider", async () => {
	await query("insert into api_turn values($1,'queued')", [session]);
	const { client, source } = provider();
	await expect(recycleWorkspace(client, session)).rejects.toThrow("idle");
	expect(source.update).not.toHaveBeenCalled();
});
it("refuses silently replacing an expired retained snapshot", async () => {
	await query(
		"update workspace_retention set phase='retained',snapshot_id='snapshot',verified_at=now(),expires_at=now()-interval '1 second'",
	);
	await expect(
		restoreRetainedWorkspace(provider().client, "alice", session, "source"),
	).rejects.toThrow("expired");
	expect(
		await restoreRetainedWorkspace(
			provider().client,
			"other",
			session,
			"source",
		),
	).toBeNull();
});
it("fails closed on a symlinked project root during restore checks", async () => {
	const vm = { exec: async () => ({ statusCode: 64, stdout: "" }) };
	await expect(retainedTreeDigest(vm, ["/home/ubuntu/repo"])).rejects.toThrow(
		"symlinked project root",
	);
});
it("retention metadata stays server-only and deleting it does not delete a chat", async () => {
	expect(
		(
			await query(
				"select relrowsecurity from pg_class where relname='workspace_retention'",
			)
		).rows[0],
	).toMatchObject({ relrowsecurity: true });
	await query("delete from workspace_retention");
	expect((await query("select * from agent_session")).rows).toHaveLength(1);
});
it("protects machines created before the fixed rollout cutover", async () => {
	await query("delete from workspace_retention");
	vi.stubEnv("YTIMESY_RETENTION_ENROLL_AFTER", "2026-10-03T00:00:00Z");
	const data = await provider().source.data();
	const connection = { query } as unknown as Parameters<
		typeof touchWorkspaceRetention
	>[0];
	await touchWorkspaceRetention(
		connection,
		data as Parameters<typeof touchWorkspaceRetention>[1],
	);
	expect((await query("select * from workspace_retention")).rows).toHaveLength(
		0,
	);
	await touchWorkspaceRetention(connection, {
		...data,
		createdAt: "2026-10-04T00:00:00Z",
	} as Parameters<typeof touchWorkspaceRetention>[1]);
	expect((await query("select * from workspace_retention")).rows).toHaveLength(
		1,
	);
});
it("self-heals a touch only for the chat's current VM while active", async () => {
	const connection = { query } as unknown as Parameters<
		typeof touchWorkspaceRetention
	>[0];
	const data = {
		...(await provider().source.data()),
		id: "replacement",
		resources: { cpu: 4, memory: 8192, storage: 16384 },
	} as Parameters<typeof touchWorkspaceRetention>[1];
	const row = async () =>
		(await query("select phase,vm_id,resources from workspace_retention"))
			.rows[0];
	// The chat still names "source": a caller holding another VM is stale.
	await expect(touchWorkspaceRetention(connection, data)).rejects.toThrow(
		"binding changed",
	);
	expect(await row()).toMatchObject({ vm_id: "source" });
	// Mid-recovery stays refused even for the chat's current VM.
	await query("update agent_session set provider_ref='replacement'");
	await query("update workspace_retention set phase='capturing'");
	await expect(touchWorkspaceRetention(connection, data)).rejects.toThrow(
		"in progress",
	);
	expect(await row()).toMatchObject({ phase: "capturing", vm_id: "source" });
	// Active and the chat's VM was replaced: the row follows it.
	await query("update workspace_retention set phase='active'");
	await touchWorkspaceRetention(connection, data);
	expect(await row()).toMatchObject({
		phase: "active",
		vm_id: "replacement",
		resources: data.resources,
	});
	// A stale caller on the old VM is now refused.
	await expect(
		touchWorkspaceRetention(connection, { ...data, id: "source" }),
	).rejects.toThrow("binding changed");
});
it("rebinds retention to a replacement only from the chat's lost VM", async () => {
	const row = async () =>
		(await query("select vm_id from workspace_retention")).rows[0];
	// Bound to some other VM: untouched.
	await rebindWorkspaceRetention(session, "elsewhere", "replacement");
	expect(await row()).toMatchObject({ vm_id: "source" });
	// The chat no longer names either VM: untouched.
	await query("update agent_session set provider_ref='third'");
	await rebindWorkspaceRetention(session, "source", "replacement");
	expect(await row()).toMatchObject({ vm_id: "source" });
	// Mid-recovery: untouched.
	await query("update agent_session set provider_ref='source'");
	await query("update workspace_retention set phase='capturing'");
	await rebindWorkspaceRetention(session, "source", "replacement");
	expect(await row()).toMatchObject({ vm_id: "source" });
	// Active, chat still on the lost VM: moves to the replacement.
	await query("update workspace_retention set phase='active'");
	await rebindWorkspaceRetention(session, "source", "replacement");
	expect(await row()).toMatchObject({ vm_id: "replacement" });
});
it("backs off failed retirement so other idle workspaces can proceed", async () => {
	await expect(
		recycleWorkspace(provider({ mismatch: true }).client, session),
	).rejects.toThrow();
	expect(
		(
			await query(
				"select retry_after > now() as deferred from workspace_retention",
			)
		).rows[0],
	).toMatchObject({ deferred: true });
});
it("reuses a matching recovery copy and atomically binds the session", async () => {
	await query(
		"update workspace_retention set phase='retained',snapshot_id='snapshot',verified_at=now(),expires_at=now()+interval '90 days'",
	);
	const { client } = provider();
	const missing = Object.assign(Object.create(FreestyleApiError.prototype), {
		status: 404,
	});
	client.vms.ref = (() => ({
		data: async () => {
			throw missing;
		},
	})) as unknown as typeof client.vms.ref;
	client.vms.list = vi.fn(async () => ({
		vms: [{ id: "restored", snapshotId: "snapshot", resources }],
	})) as unknown as typeof client.vms.list;
	expect(
		await restoreRetainedWorkspace(client, "alice", session, "source"),
	).toBe("restored");
	expect(
		(await query("select provider_ref from agent_session")).rows[0],
	).toMatchObject({ provider_ref: "restored" });
	expect(
		(await query("select phase,vm_id from workspace_retention")).rows[0],
	).toMatchObject({ phase: "active", vm_id: "restored" });
	expect(client.vms.create).not.toHaveBeenCalled();
});
it("rolls back recovery metadata if the session binding changed concurrently", async () => {
	await query(
		"update workspace_retention set phase='retained',snapshot_id='snapshot',verified_at=now(),expires_at=now()+interval '90 days'",
	);
	await query("update agent_session set provider_ref='different'");
	const { client } = provider();
	const missing = Object.assign(Object.create(FreestyleApiError.prototype), {
		status: 404,
	});
	client.vms.ref = (() => ({
		data: async () => {
			throw missing;
		},
	})) as unknown as typeof client.vms.ref;
	client.vms.list = vi.fn(async () => ({
		vms: [{ id: "restored", snapshotId: "snapshot", resources }],
	})) as unknown as typeof client.vms.list;
	await expect(
		restoreRetainedWorkspace(client, "alice", session, "source"),
	).rejects.toThrow("Session binding changed");
	expect(
		(await query("select phase,vm_id from workspace_retention")).rows[0],
	).toMatchObject({ phase: "retained", vm_id: "source" });
});
it("expires only the owned recovery artifact, preserving conversation and VM", async () => {
	await query(
		"update workspace_retention set phase='retained',snapshot_id='snapshot',verified_at=now(),expires_at=now()-interval '1 day'",
	);
	const { client, source } = provider();
	await expireRetainedWorkspace(client);
	expect(client.vms.snapshots.delete).toHaveBeenCalledWith("snapshot");
	expect(source.delete).not.toHaveBeenCalled();
	expect((await query("select * from agent_session")).rows).toHaveLength(1);
	expect(
		(await query("select phase,snapshot_id from workspace_retention")).rows[0],
	).toMatchObject({ phase: "expired", snapshot_id: null });
});

it("defers a verification past its time budget: keeps the VM, logs once, no throw", async () => {
	const { client, source } = provider();
	// The in-guest digest is killed by its exec timeout: no status code.
	source.exec.mockImplementation(async (input: { command: string }) =>
		input.command.includes("ytimesy-tree-v2")
			? { statusCode: null }
			: { statusCode: 0 },
	);
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	await expect(recycleIdleWorkspaces(client)).resolves.toBeUndefined();
	expect(source.snapshot).not.toHaveBeenCalled();
	expect(source.delete).not.toHaveBeenCalled();
	expect(info).toHaveBeenCalledTimes(1);
	expect(info.mock.calls[0][1]).toMatchObject({
		sessionId: session,
		category: "timeout",
		reason: expect.stringContaining("time budget"),
	});
	info.mockRestore();
	expect(
		(
			await query(
				"select phase, retry_after > now() as deferred from workspace_retention",
			)
		).rows[0],
	).toMatchObject({ phase: "active", deferred: true });
	// A direct call still reports the deferral to its caller.
	await query("update workspace_retention set retry_after=now()");
	const slow = provider();
	slow.source.exec.mockImplementation(async (input: { command: string }) =>
		input.command.includes("ytimesy-tree-v2")
			? { statusCode: null }
			: { statusCode: 0 },
	);
	await expect(recycleWorkspace(slow.client, session)).rejects.toBeInstanceOf(
		RecycleDeferred,
	);
});

it("treats a source VM the provider no longer has as already gone", async () => {
	const { client, source } = provider();
	const missing = new FreestyleApiError(
		404,
		{ code: "NOT_FOUND", message: "not found: vm source" },
		"/v5/vms/source",
	);
	source.data = async () => {
		throw missing;
	};
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	await expect(recycleIdleWorkspaces(client)).resolves.toBeUndefined();
	info.mockRestore();
	expect(source.snapshot).not.toHaveBeenCalled();
	expect((await query("select * from workspace_retention")).rows).toHaveLength(
		0,
	);
	expect((await query("select * from agent_session")).rows).toHaveLength(1);
});

it("keeps a 404 from anything but the source VM a failure", async () => {
	const { client, source } = provider();
	const update = source.update;
	source.update = vi.fn(async (input: { maxRunTotalSeconds: number }) => {
		await update(input);
		throw new FreestyleApiError(
			404,
			{ code: "NOT_FOUND", message: "not found" },
			"/v5/other",
		);
	});
	await expect(recycleWorkspace(client, session)).rejects.toBeInstanceOf(
		FreestyleApiError,
	);
	expect(
		(await query("select phase from workspace_retention")).rows[0],
	).toMatchObject({ phase: "active" });
});
