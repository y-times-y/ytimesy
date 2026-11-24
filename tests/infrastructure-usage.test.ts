import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { type Freestyle, FreestyleApiError, type VmData } from "freestyle";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { utcUsageMonth } from "../src/domain/infrastructure-usage";
import {
	admitVmCreate,
	admitVmResume,
	forgetRecentAdmission,
	recentAdmissionCovers,
	reconcileInfrastructureVms,
	reconcilePausedVm,
	START_GRACE_SECONDS,
} from "../src/server/adapters/freestyle/usage-admission";
import {
	adjustInfrastructureAllowance,
	assertUsageWindowsOpen,
	reserveInfrastructureUsage,
	settleInfrastructureUsage,
	userInfrastructureUsage,
} from "../src/server/adapters/infrastructure-usage";

let db: PGlite;
const query = async (sql: string, params: unknown[] = []) => {
	const result = await db.query(sql, params);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values('alice'),('bob'),('admin'); create table workspace(id uuid,user_id text); create table agent_session(id uuid,user_id text); create table environment_build(id uuid,workspace_id uuid); create table api_turn(id text,user_id text,state text,session_id text); insert into workspace values('00000000-0000-4000-8000-0000000000a1','alice'),('00000000-0000-4000-8000-0000000000a2','alice'); insert into environment_build values('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1');",
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261003020000_infrastructure_usage.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261003021000_infrastructure_vm_identity.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261003024000_infrastructure_zero_runtime.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261013060000_infrastructure_vm_lease.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261020130000_infrastructure_usage_windows.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261026120000_infrastructure_usage_total.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261110120000_infrastructure_usage_window_start.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261114180000_infrastructure_usage_auto_reset.sql",
			"utf8",
		),
	);
});
beforeEach(async () => {
	vi.stubEnv("YTIMESY_ADMIN_USER_IDS", "admin");
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "100");
	vi.stubEnv("YTIMESY_USER_WEEKLY_MICRO_USD", "100");
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "150");
	vi.stubEnv("YTIMESY_FLEET_LIFETIME_MICRO_USD", "1000");
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	await db.exec(
		"truncate infrastructure_usage_window,infrastructure_vm_lease,infrastructure_vm_admission,infrastructure_usage_reservation,infrastructure_usage_adjustment,infrastructure_usage_policy,api_turn;",
	);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await db.close();
});
const reservation = (userId = "alice", amountMicroUsd = 60) => ({
	id: randomUUID(),
	userId,
	resourceKey: "vm:one",
	amountMicroUsd,
});

function enableVmAllowance() {
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "true");
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "66120");
	vi.stubEnv("YTIMESY_USER_WEEKLY_MICRO_USD", "66120");
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "500000000");
	vi.stubEnv("YTIMESY_FLEET_LIFETIME_MICRO_USD", "7000000000");
}

it("reserves before create, reuses uncertain admission and rejects ownerless VMs", async () => {
	enableVmAllowance();
	const client = {
		vms: { ref: () => ({ data: async () => ({}) }) },
	} as unknown as Freestyle;
	const create = vi.fn(async (_cap?: number) => "new-vm");
	const uncertain = vi.fn(async (_cap?: number): Promise<string> => {
		throw new Error("uncertain");
	});
	await expect(
		admitVmCreate(
			client,
			"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
			"freestyle/ubuntu-sm",
			uncertain,
		),
	).rejects.toThrow("uncertain");
	await admitVmCreate(
		client,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"freestyle/ubuntu-sm",
		create,
	);
	expect(create).toHaveBeenCalledWith(300);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(13224);
	await expect(
		admitVmCreate(
			client,
			"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
			"freestyle/ubuntu-sm",
			create,
		),
	).rejects.toThrow("generation changed");
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(13224);
	await expect(
		admitVmCreate(client, "unknown", "freestyle/ubuntu-sm", create),
	).rejects.toThrow("owner");
	expect(create).toHaveBeenCalledTimes(1);
});

it("sizes the shared tools image as the base image, with no source VM to read", async () => {
	enableVmAllowance();
	vi.stubEnv("YTIMESY_TOOLS_SNAPSHOT_ID", "sh-tools");
	const client = {
		vms: {
			snapshots: {
				get: async () => {
					throw new Error("source VM lookup");
				},
			},
		},
	} as unknown as Freestyle;
	const create = vi.fn(async (_cap?: number) => "vm");
	await admitVmCreate(
		client,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"sh-tools",
		create,
	);
	expect(create).toHaveBeenCalledWith(300);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(13224);
	await expect(
		admitVmCreate(
			client,
			"ytimesy-ws-00000000-0000-4000-8000-0000000000a2",
			"sh-other",
			create,
		),
	).rejects.toThrow("source VM lookup");
});

it("reserves the larger requested copy shape before provisioning", async () => {
	enableVmAllowance();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"freestyle/ubuntu-sm",
		async () => "vm",
		300,
		{ cpu: 4, memory: 16384, storage: 32768 },
	);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(36768);
});

it("uses provider runtime counters and confirms caps before a caller can resume", async () => {
	enableVmAllowance();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"freestyle/ubuntu-sm",
		async () => "vm",
	);
	const data = {
		id: "vm",
		slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		resources: { cpu: 2, memory: 4096, storage: 16384 },
		totalRunSeconds: 300,
		maxRunTotalSeconds: 300,
	} as VmData;
	const vm = {
		data: async () => data,
		update: vi.fn(async (fields: { maxRunTotalSeconds: number }) => {
			data.maxRunTotalSeconds = fields.maxRunTotalSeconds;
		}),
	};
	await admitVmResume(
		vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
		data,
	);
	expect(vm.update).toHaveBeenCalledWith({
		maxRunTotalSeconds: 600,
		automaticRestart: false,
	});
	expect(await userInfrastructureUsage("alice")).toMatchObject({
		consumedMicroUsd: 11020,
		reservedMicroUsd: 13224,
	});
	data.resources.cpu = 4;
	await expect(
		admitVmResume(vm as unknown as ReturnType<Freestyle["vms"]["ref"]>, data),
	).rejects.toThrow("resources changed");
});

it.each([
	{ providerCap: 300, automaticRestart: false, expectedUpdates: 0 },
	{ providerCap: 150, automaticRestart: false, expectedUpdates: 1 },
	{ providerCap: 300, automaticRestart: true, expectedUpdates: 1 },
])(
	"only rewrites provider caps when fresh state needs it: $providerCap/$automaticRestart",
	async ({ providerCap, automaticRestart, expectedUpdates }) => {
		enableVmAllowance();
		await admitVmCreate(
			{} as Freestyle,
			"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
			"freestyle/ubuntu-sm",
			async () => "vm",
		);
		const data = {
			id: "vm",
			slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
			state: "running",
			resources: { cpu: 2, memory: 4096, storage: 16384 },
			totalRunSeconds: 0,
			maxRunTotalSeconds: providerCap,
			automaticRestart,
		} as VmData;
		const vm = {
			data: vi.fn(async () => data),
			update: vi.fn(
				async (fields: {
					maxRunTotalSeconds: number;
					automaticRestart: boolean;
				}) => {
					Object.assign(data, fields);
				},
			),
		};
		const hold = (await userInfrastructureUsage("alice")).reservedMicroUsd;
		await admitVmResume(
			vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
			data,
		);
		expect(vm.update).toHaveBeenCalledTimes(expectedUpdates);
		expect(vm.data).toHaveBeenCalledTimes(1 + expectedUpdates);
		expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(
			hold,
		);
	},
);

it("reuses a running VM's admission for a minute only while it still covers the operation", async () => {
	enableVmAllowance();
	forgetRecentAdmission();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"freestyle/ubuntu-sm",
		async () => "vm",
	);
	const data = {
		id: "vm",
		slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		state: "running",
		resources: { cpu: 2, memory: 4096, storage: 16384 },
		totalRunSeconds: 0,
		maxRunTotalSeconds: 300,
		automaticRestart: false,
	} as VmData;
	const vm = { data: vi.fn(async () => data), update: vi.fn() };
	// Nothing admitted yet: the first operation always takes the full path.
	expect(recentAdmissionCovers(data, 60)).toBe(false);
	await admitVmResume(
		vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
		data,
	);
	const now = Date.now();
	expect(recentAdmissionCovers(data, 60, now)).toBe(true);
	// The full path would extend the cap here, so it must run.
	expect(recentAdmissionCovers(data, 290, now)).toBe(false);
	expect(recentAdmissionCovers(data, 60, now + 61_000)).toBe(false);
	await admitVmResume(
		vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
		data,
	);
	for (const changed of [
		{ state: "paused" },
		{ maxRunTotalSeconds: 600 },
		{ automaticRestart: true },
		{ totalRunSeconds: 260 },
	] as Partial<VmData>[])
		expect(recentAdmissionCovers({ ...data, ...changed }, 60, now)).toBe(false);
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	expect(recentAdmissionCovers(data, 60, now)).toBe(false);
});

it("does not call the VM creator when spending would exceed the fleet ceiling", async () => {
	enableVmAllowance();
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "1");
	const create = vi.fn(async () => "vm");
	await expect(
		admitVmCreate(
			{} as Freestyle,
			"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
			"freestyle/ubuntu-sm",
			create,
		),
	).rejects.toThrow("fleet");
	expect(create).not.toHaveBeenCalled();
});

it("extends an active VM before a long command without charging its earlier hold twice", async () => {
	enableVmAllowance();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"freestyle/ubuntu-sm",
		async () => "vm",
	);
	await db.exec(
		"update infrastructure_vm_admission set updated_at=now()-interval '4 minutes'",
	);
	const data = {
		id: "vm",
		slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		state: "running",
		resources: { cpu: 2, memory: 4096, storage: 16384 },
		totalRunSeconds: 0,
		maxRunTotalSeconds: 300,
	} as VmData;
	const vm = {
		data: async () => data,
		update: async (input: { maxRunTotalSeconds: number }) => {
			data.maxRunTotalSeconds = input.maxRunTotalSeconds;
		},
	};
	await admitVmResume(
		vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
		data,
		120,
	);
	expect(data.maxRunTotalSeconds).toBe(600);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(24244);
	await admitVmResume(
		vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
		data,
		120,
	);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(24244);
});

it("resolves setup ownership through the workspace and funds long preparation without a monthly bound", async () => {
	enableVmAllowance();
	const create = vi.fn(async (_cap?: number) => "build-vm");
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-build-00000000-0000-4000-8000-0000000000b1",
		"freestyle/ubuntu-sm",
		create,
		3600,
	);
	// Usage windows gate starting work, not its size: the full hour is held.
	expect(create).toHaveBeenCalledWith(3600);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(
		Math.ceil((3660 * 132_240) / 3600),
	);
});

/** A reconcile run after a fresh admission's start grace (START_GRACE_SECONDS). */
const pastStartGrace = () => Date.now() + (START_GRACE_SECONDS + 1) * 1000;

it("retains a paused hold if the provider fails to confirm revocation", async () => {
	enableVmAllowance();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"freestyle/ubuntu-sm",
		async () => "vm",
	);
	const data = {
		id: "vm",
		slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		state: "paused",
		totalRunSeconds: 23,
		maxRunTotalSeconds: 300,
	} as VmData;
	const vm = { data: async () => data, update: async () => {} };
	await expect(
		reconcilePausedVm(
			vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
			pastStartGrace(),
		),
	).rejects.toThrow("confirmed");
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(13224);
});

it.each([0, 23])(
	"revokes the remaining provider cap before refunding a paused VM with %i seconds, then permits funded resume",
	async (runtime) => {
		enableVmAllowance();
		await admitVmCreate(
			{} as Freestyle,
			"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
			"freestyle/ubuntu-sm",
			async () => "vm",
		);
		const data = {
			id: "vm",
			slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
			state: "paused",
			resources: { cpu: 2, memory: 4096, storage: 16384 },
			totalRunSeconds: runtime,
			maxRunTotalSeconds: 300,
		} as VmData;
		const vm = {
			data: async () => data,
			update: vi.fn(async (input: { maxRunTotalSeconds: number }) => {
				data.maxRunTotalSeconds = input.maxRunTotalSeconds;
			}),
		};
		await reconcilePausedVm(
			vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
			pastStartGrace(),
		);
		expect(data.maxRunTotalSeconds).toBe(runtime);
		expect(await userInfrastructureUsage("alice")).toMatchObject({
			consumedMicroUsd: Math.ceil((runtime * 132240) / 3600),
			reservedMicroUsd: 0,
		});
		await admitVmResume(
			vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
			data,
		);
		expect(data.maxRunTotalSeconds).toBe(300 + runtime);
		expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(
			13224,
		);
	},
);

it("funds the requested long operation before resuming a paused machine", async () => {
	enableVmAllowance();
	const data = {
		id: "vm",
		slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		state: "paused",
		resources: { cpu: 2, memory: 4096, storage: 16384 },
		totalRunSeconds: 0,
		maxRunTotalSeconds: 0,
	} as VmData;
	const vm = {
		data: async () => data,
		update: vi.fn(async (input: { maxRunTotalSeconds: number }) => {
			data.maxRunTotalSeconds = input.maxRunTotalSeconds;
		}),
	};
	await admitVmResume(
		vm as unknown as ReturnType<Freestyle["vms"]["ref"]>,
		data,
		900,
	);
	expect(data.maxRunTotalSeconds).toBe(915);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(35815);
});

it("refuses new holds once a window is exhausted, but never work already running", async () => {
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "1000");
	await reserveInfrastructureUsage(reservation());
	// Under the 5-hour limit a start is admitted even if it carries past it
	// (within the ceiling: the limit plus an hour of the machine).
	await reserveInfrastructureUsage({
		...reservation(),
		resourceKey: "vm:two",
		hourlyMicroUsd: 100,
	});
	const before = await userInfrastructureUsage("alice");
	expect(before.windows.map((window) => window.exhausted)).toEqual([
		true,
		true,
	]);
	await expect(
		reserveInfrastructureUsage({ ...reservation(), resourceKey: "vm:two" }),
	).rejects.toThrow(/reached your weekly cloud usage limit.*until \d{4}/);
	// A machine that is already running keeps buying runtime, up to the
	// ceiling: the limit plus an hour of that machine (here 200).
	await reserveInfrastructureUsage({
		...reservation(),
		resourceKey: "vm:two",
		hourlyMicroUsd: 200,
		continuing: true,
	});
	// So does a start of the machine of a session whose turn still runs; a
	// turn of another session (a new subagent's fork) exempts nothing.
	const session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	const own = {
		resourceKey: "vm:ytimesy-ag-aaaaaaaabbbb4ccc",
		hourlyMicroUsd: 200,
	};
	await query("insert into api_turn values('t0','alice','running','other')");
	await expect(
		reserveInfrastructureUsage({ ...reservation(), ...own }),
	).rejects.toThrow(/reached your weekly cloud usage limit/);
	await query("insert into api_turn values('t1','alice','running',$1)", [
		session,
	]);
	await reserveInfrastructureUsage({ ...reservation(), ...own });
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(240);
	// Past the ceiling nothing extends, running or not; a hold that may shrink
	// gets what is left (300 - 240), never less than its minimum.
	await expect(
		reserveInfrastructureUsage({
			...reservation("alice", 61),
			...own,
			continuing: true,
		}),
	).rejects.toThrow(/grace past your (?:5-hour|weekly) cloud usage limit/);
	expect(
		await reserveInfrastructureUsage({
			...reservation("alice", 61),
			...own,
			continuing: true,
			minimumMicroUsd: 50,
		}),
	).toBe(60);
	await expect(
		reserveInfrastructureUsage({
			...reservation("alice", 10),
			...own,
			continuing: true,
			minimumMicroUsd: 1,
		}),
	).rejects.toThrow(/grace past your/);
	expect(await userInfrastructureUsage("bob")).toMatchObject({
		reservedMicroUsd: 0,
		windows: [
			{ id: "five_hour", usedMicroUsd: 0, exhausted: false },
			{ id: "weekly", usedMicroUsd: 0, exhausted: false },
		],
	});
});
it("resets the 5-hour window at its fixed time, while the weekly one still counts it", async () => {
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "1000");
	vi.stubEnv("YTIMESY_USER_WEEKLY_MICRO_USD", "1000");
	const hold = reservation("alice", 100);
	await reserveInfrastructureUsage(hold);
	await settleInfrastructureUsage({
		id: hold.id,
		userId: "alice",
		consumedMicroUsd: 100,
	});
	await expect(reserveInfrastructureUsage(reservation())).rejects.toThrow(
		"5-hour cloud usage limit",
	);
	await query(
		"update infrastructure_usage_reservation set settled_at=settled_at-interval '7 hours',created_at=created_at-interval '7 hours'",
	);
	await query(
		"update infrastructure_usage_window set started_at=started_at-interval '7 hours'",
	);
	const usage = await userInfrastructureUsage("alice");
	expect(usage.windows).toMatchObject([
		{ id: "five_hour", usedMicroUsd: 0, exhausted: false, resetsAt: null },
		{ id: "weekly", usedMicroUsd: 100, usedPercent: 10 },
	]);
	await reserveInfrastructureUsage(reservation());
	// That usage started a new 5-hour window; the weekly one keeps its start.
	const after = await userInfrastructureUsage("alice");
	expect(after.windows[0].resetsAt).toBeGreaterThan(
		Date.now() + 4.9 * 3_600_000,
	);
	expect(after.windows[1].resetsAt).toBeLessThan(
		Date.now() + 6.8 * 24 * 3_600_000,
	);
});
it("fixes a window's reset time at its first usage and keeps it as more usage arrives", async () => {
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "1000");
	vi.stubEnv("YTIMESY_USER_WEEKLY_MICRO_USD", "1000");
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "1000");
	const first = reservation("alice", 100);
	await reserveInfrastructureUsage(first);
	await query(
		"update infrastructure_usage_window set started_at=started_at-interval '2 hours'",
	);
	await query(
		"update infrastructure_usage_reservation set created_at=created_at-interval '2 hours'",
	);
	const before = (await userInfrastructureUsage("alice")).windows[0].resetsAt;
	expect(before).not.toBeNull();
	await settleInfrastructureUsage({
		id: first.id,
		userId: "alice",
		consumedMicroUsd: 100,
	});
	await reserveInfrastructureUsage(reservation("alice", 300));
	await reserveInfrastructureUsage(reservation("alice", 600));
	const exhausted = await userInfrastructureUsage("alice");
	expect(exhausted.windows[0]).toMatchObject({
		usedMicroUsd: 1000,
		exhausted: true,
		resetsAt: before,
	});
	await expect(assertUsageWindowsOpen("alice")).rejects.toThrow(
		"cloud usage limit",
	);
});
it("retries a hold once and rejects changing its owner or amount", async () => {
	const hold = reservation();
	await reserveInfrastructureUsage(hold);
	await reserveInfrastructureUsage(hold);
	await expect(
		reserveInfrastructureUsage({ ...hold, userId: "bob" }),
	).rejects.toThrow("identity changed");
	await expect(
		reserveInfrastructureUsage({ ...hold, amountMicroUsd: 61 }),
	).rejects.toThrow("identity changed");
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(60);
});
it("settles once, keeps the first total, and releases only verified unused usage", async () => {
	const hold = reservation();
	await reserveInfrastructureUsage(hold);
	await expect(
		settleInfrastructureUsage({
			id: hold.id,
			userId: "bob",
			consumedMicroUsd: 20,
		}),
	).rejects.toThrow();
	await settleInfrastructureUsage({
		id: hold.id,
		userId: "alice",
		consumedMicroUsd: 20,
	});
	await settleInfrastructureUsage({
		id: hold.id,
		userId: "alice",
		consumedMicroUsd: 20,
	});
	// A later, different settlement (more than reserved, or less) never
	// refuses (a refusal once kept a chat's VM from waking): it keeps the
	// first total and logs the difference.
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await settleInfrastructureUsage({
		id: hold.id,
		userId: "alice",
		consumedMicroUsd: 61,
	});
	await settleInfrastructureUsage({
		id: hold.id,
		userId: "alice",
		consumedMicroUsd: 0,
	});
	expect(warn).toHaveBeenCalledTimes(2);
	warn.mockRestore();
	await expect(reserveInfrastructureUsage(hold)).rejects.toThrow(
		"already settled",
	);
	expect(await userInfrastructureUsage("alice")).toMatchObject({
		consumedMicroUsd: 20,
		reservedMicroUsd: 0,
	});
	expect((await userInfrastructureUsage("alice")).windows[0]).toMatchObject({
		id: "five_hour",
		usedMicroUsd: 20,
		usedPercent: 20,
	});
});
it("permits audited per-user window overrides including self, but never bypasses the fleet budget", async () => {
	const override = {
		id: randomUUID(),
		actorId: "admin",
		userId: "admin",
		kind: "five_hour_limit" as const,
		amountMicroUsd: 200,
		reason: "Dogfood testing",
	};
	await expect(
		adjustInfrastructureAllowance({ ...override, actorId: "alice" }),
	).rejects.toBeInstanceOf(Response);
	await adjustInfrastructureAllowance(override);
	await adjustInfrastructureAllowance(override);
	await adjustInfrastructureAllowance({
		...override,
		id: randomUUID(),
		kind: "weekly_limit",
		amountMicroUsd: 300,
	});
	expect(
		(await userInfrastructureUsage("admin")).windows.map(
			(window) => window.limitMicroUsd,
		),
	).toEqual([200, 300]);
	// Other users keep the deployment's limits.
	expect(
		(await userInfrastructureUsage("alice")).windows.map(
			(window) => window.limitMicroUsd,
		),
	).toEqual([100, 100]);
	await reserveInfrastructureUsage(reservation("admin", 140));
	await expect(
		reserveInfrastructureUsage(reservation("bob", 20)),
	).rejects.toThrow("fleet");
	expect(
		(
			await query(
				"select count(*) as count from infrastructure_usage_adjustment",
			)
		).rows,
	).toEqual([{ count: 2 }]);
});
it("counts a running machine's hold however old it is", async () => {
	await reserveInfrastructureUsage(reservation("alice", 100));
	await query(
		"update infrastructure_usage_reservation set period='2020-01-01',created_at=now()-interval '30 days'",
	);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(100);
	await expect(reserveInfrastructureUsage(reservation())).rejects.toThrow(
		"cloud usage limit",
	);
});
it("fails closed on invalid configuration and unknown users", async () => {
	await expect(
		reserveInfrastructureUsage(reservation("missing")),
	).rejects.toThrow("unavailable");
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "");
	await expect(reserveInfrastructureUsage(reservation())).rejects.toThrow(
		"YTIMESY_USER_5H_MICRO_USD must be configured",
	);
	await expect(userInfrastructureUsage("alice")).rejects.toThrow(
		"must be configured",
	);
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "100");
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "NaN");
	await expect(reserveInfrastructureUsage(reservation())).rejects.toThrow(
		"Invalid",
	);
});

it("does not replenish a lifetime fleet budget when a new month begins", async () => {
	vi.stubEnv("YTIMESY_FLEET_LIFETIME_MICRO_USD", "100");
	const hold = reservation();
	await reserveInfrastructureUsage(hold);
	await settleInfrastructureUsage({
		id: hold.id,
		userId: "alice",
		consumedMicroUsd: 60,
	});
	await query(
		"update infrastructure_usage_reservation set period='2020-01-01'",
	);
	await expect(
		reserveInfrastructureUsage(reservation("bob", 60)),
	).rejects.toThrow("lifetime fleet");
});
it("uses UTC month boundaries and keeps infrastructure tables unavailable to browser roles", async () => {
	expect(utcUsageMonth(new Date("2026-11-01T00:30:00Z"))).toBe("2026-11-01");
	expect(
		(
			await query(
				"select relrowsecurity from pg_class where relname='infrastructure_usage_reservation'",
			)
		).rows,
	).toEqual([{ relrowsecurity: true }]);
	expect(
		(
			await query(
				"select has_table_privilege('authenticated','infrastructure_usage_reservation','INSERT') as allowed",
			)
		).rows,
	).toEqual([{ allowed: false }]);
});

it("leaves a just-admitted paused VM's cap alone while its start is still in flight", async () => {
	// 2026-11-19: the minute sweep revoked a fresh cap 66 s into a 93 s start,
	// and the start failed on "used its total runtime budget of 188s".
	enableVmAllowance();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"freestyle/ubuntu-sm",
		async () => "vm",
	);
	const data = {
		id: "vm",
		slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		state: "paused",
		resources: { cpu: 2, memory: 4096, storage: 16384 },
		totalRunSeconds: 0,
		maxRunTotalSeconds: 300,
	} as VmData;
	const vm = { data: async () => data, update: vi.fn() };
	await reconcileInfrastructureVms({
		vms: { ref: () => vm },
	} as unknown as Freestyle);
	expect(vm.update).not.toHaveBeenCalled();
	expect(data.maxRunTotalSeconds).toBe(300);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(13224);
});

it("settles stopped VMs like paused ones and converts a deleted VM's hold into usage", async () => {
	enableVmAllowance();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		"freestyle/ubuntu-sm",
		async () => "vm-stopped",
	);
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-00000000-0000-4000-8000-0000000000a2",
		"freestyle/ubuntu-sm",
		async () => "vm-deleted",
	);
	const stopped = {
		id: "vm-stopped",
		slug: "ytimesy-ws-00000000-0000-4000-8000-0000000000a1",
		state: "stopped",
		resources: { cpu: 2, memory: 4096, storage: 16384 },
		totalRunSeconds: 10,
		maxRunTotalSeconds: 300,
	} as VmData;
	const client = {
		vms: {
			ref: (id: string) => ({
				data: async () => {
					if (id === "vm-deleted")
						throw new FreestyleApiError(404, {
							code: "NOT_FOUND",
							message: "not found",
						} as never);
					return stopped;
				},
				update: async (input: { maxRunTotalSeconds: number }) => {
					stopped.maxRunTotalSeconds = input.maxRunTotalSeconds;
				},
			}),
		},
	} as unknown as Freestyle;
	await reconcileInfrastructureVms(client, pastStartGrace());
	const usage = await userInfrastructureUsage("alice");
	expect(usage.reservedMicroUsd).toBe(0);
	// The stopped VM pays for its 10 seconds; the deleted one keeps its whole hold.
	expect(usage.consumedMicroUsd).toBe(Math.ceil((10 * 132240) / 3600) + 13224);
});

it("holds back a new turn while a window is exhausted, naming when it reopens", async () => {
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "1000");
	await assertUsageWindowsOpen("alice");
	await reserveInfrastructureUsage(reservation("alice", 100));
	await expect(assertUsageWindowsOpen("alice")).rejects.toThrow(
		/reached your weekly cloud usage limit, so new work cannot start until/,
	);
	await assertUsageWindowsOpen("bob");
});

it("keeps the running fleet totals equal to summing every reservation", async () => {
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "1000");
	const sums = async () =>
		(
			await query(
				`select
				 (select coalesce(sum(case when consumed_micro_usd is null then reserved_micro_usd else consumed_micro_usd end),0)
				  from infrastructure_usage_reservation where period=$1::date or consumed_micro_usd is null)::text as fleet,
				 (select coalesce(sum(coalesce(consumed_micro_usd,reserved_micro_usd)),0) from infrastructure_usage_reservation)::text as lifetime`,
				[utcUsageMonth()],
			)
		).rows[0];
	const totals = async () =>
		(
			await query(
				`select (select coalesce(sum(case when period=$1::date then charged_micro_usd else open_micro_usd end),0)
				  from infrastructure_usage_total)::text as fleet,
				 (select coalesce(sum(charged_micro_usd),0) from infrastructure_usage_total)::text as lifetime`,
				[utcUsageMonth()],
			)
		).rows[0];
	const settled = reservation("alice", 30);
	await reserveInfrastructureUsage(settled);
	await settleInfrastructureUsage({
		id: settled.id,
		userId: "alice",
		consumedMicroUsd: 12,
	});
	const old = reservation("bob", 40);
	await reserveInfrastructureUsage(old);
	await query(
		"update infrastructure_usage_reservation set period='2020-01-01' where id=$1",
		[old.id],
	);
	const grown = reservation("alice", 20);
	await reserveInfrastructureUsage(grown);
	await reserveInfrastructureUsage(
		{ ...grown, amountMicroUsd: 35 },
		undefined,
		"increase",
	);
	const removed = reservation("bob", 10);
	await reserveInfrastructureUsage(removed);
	await query("delete from infrastructure_usage_reservation where id=$1", [
		removed.id,
	]);
	expect(await sums()).toEqual({ fleet: "87", lifetime: "87" });
	expect(await totals()).toEqual(await sums());
	await query(
		"update infrastructure_usage_reservation set consumed_micro_usd=reserved_micro_usd,settled_at=now() where id=$1",
		[old.id],
	);
	expect(await totals()).toEqual(await sums());
	expect(await sums()).toEqual({ fleet: "47", lifetime: "87" });
	await query("truncate infrastructure_usage_reservation cascade");
	expect(await totals()).toEqual({ fleet: "0", lifetime: "0" });
});
