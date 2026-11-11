import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Freestyle, VmData } from "freestyle";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CHEAP_BASE_SNAPSHOT } from "../src/server/adapters/freestyle/product-vm";
import {
	admitVmCreate,
	admitVmResume,
	forgetRecentAdmission,
	recentAdmissionCovers,
} from "../src/server/adapters/freestyle/usage-admission";
import {
	reserveInfrastructureUsage,
	settleInfrastructureUsage,
} from "../src/server/adapters/infrastructure-usage";

/**
 * Pins every billing decision of VM admission (caps, holds, settlements,
 * refusals and retention touches) against a real Postgres, and counts the
 * database round trips each path takes. The expected states were recorded
 * from the one-query-per-read implementation; a faster one must reach the
 * same decisions.
 */
let db: PGlite;
const statements: string[] = [];
const query = async (sql: string, params: unknown[] = []) => {
	statements.push(sql);
	const result = await db.query(sql, params);
	return {
		...result,
		rowCount: result.rows.length || result.affectedRows || 0,
	};
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));

const session = "00000000-0000-4000-8000-000000000001";
const slug = "ytimesy-ag-0000000000004000";
const resources = { cpu: 2, memory: 4096, storage: 16384 };
// 2 vCPU and 4 GiB: 132,240 micro-USD an hour.
const hourly = 132_240;

beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values('alice'),('bob');
	create table agent_session(id uuid primary key,user_id text,project_id text,provider_ref text,turn_status text,task_placement text,agent_role text);
	create table workspace(id uuid,user_id text); create table environment_build(id uuid,workspace_id uuid);
	create table api_turn(id text,user_id text,state text,session_id text);`);
	for (const file of [
		"20261003020000_infrastructure_usage",
		"20261003021000_infrastructure_vm_identity",
		"20261003022000_workspace_retention",
		"20261003024000_infrastructure_zero_runtime",
		"20261013060000_infrastructure_vm_lease",
		"20261020130000_infrastructure_usage_windows",
		"20261026120000_infrastructure_usage_total",
		"20261110120000_infrastructure_usage_window_start",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
});
beforeEach(async () => {
	vi.stubEnv("YTIMESY_WORKSPACE_RETENTION", "true");
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "true");
	vi.stubEnv("YTIMESY_RETENTION_ENROLL_AFTER", "2026-01-01T00:00:00Z");
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "1000000");
	vi.stubEnv("YTIMESY_USER_WEEKLY_MICRO_USD", "1000000");
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "500000000");
	vi.stubEnv("YTIMESY_FLEET_LIFETIME_MICRO_USD", "7000000000");
	forgetRecentAdmission();
	await db.exec(
		"truncate infrastructure_usage_window,workspace_retention,infrastructure_vm_lease,infrastructure_vm_admission,infrastructure_usage_reservation,infrastructure_usage_policy,infrastructure_usage_adjustment,agent_session,api_turn;",
	);
	await query(
		"insert into agent_session values($1,'alice','project','vm-1','running',null)",
		[session],
	);
	statements.length = 0;
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await db.close();
});

type Provider = {
	id: string;
	state: "running" | "paused" | "stopped";
	totalRunSeconds: number;
	maxRunTotalSeconds: number;
	automaticRestart: boolean;
	createdAt: string;
};
function machine(initial: Partial<Provider> = {}) {
	const state: Provider = {
		id: "vm-1",
		state: "running",
		totalRunSeconds: 150,
		maxRunTotalSeconds: 1000,
		automaticRestart: false,
		createdAt: "2026-06-01T00:00:00Z",
		...initial,
	};
	const updates: Partial<Provider>[] = [];
	const vm = {
		id: state.id,
		data: async () =>
			({
				...state,
				slug,
				resources,
				idleTimeoutSeconds: 180,
				autoDeleteSeconds: 7_776_000,
			}) as unknown as VmData,
		update: async (patch: Partial<Provider>) => {
			updates.push(patch);
			Object.assign(state, patch);
		},
		start: async () => {},
	};
	return { vm, state, updates };
}

async function seedAdmission(input: {
	cap: number;
	baseline: number;
	ageSeconds?: number;
	vmId?: string | null;
	userId?: string;
	hourlyMicroUsd?: number;
}) {
	const reservation = "10000000-0000-4000-8000-000000000001";
	await query(
		"insert into infrastructure_usage_reservation(id,user_id,resource_key,period,reserved_micro_usd,created_at) values($1,$2,$3,date_trunc('month',now() at time zone 'utc')::date,$4,now()-interval '1 hour')",
		[
			reservation,
			input.userId ?? "alice",
			`vm:${slug}`,
			Math.ceil(((input.cap - input.baseline + 60) * hourly) / 3600),
		],
	);
	// The hold started the user's windows, as reserving it would have.
	await query(
		"insert into infrastructure_usage_window(user_id,window_id,started_at) select $1,w,created_at from infrastructure_usage_reservation, unnest(array['five_hour','weekly']) w where id=$2 on conflict do nothing",
		[input.userId ?? "alice", reservation],
	);
	await query(
		"insert into infrastructure_vm_admission(slug,user_id,reservation_id,max_run_total_seconds,baseline_seconds,hourly_micro_usd,vm_id,updated_at) values($1,$2,$3,$4,$5,$6,$7,now()-make_interval(secs=>$8))",
		[
			slug,
			input.userId ?? "alice",
			reservation,
			input.cap,
			input.baseline,
			input.hourlyMicroUsd ?? hourly,
			input.vmId === undefined ? "vm-1" : input.vmId,
			input.ageSeconds ?? 0,
		],
	);
}
async function seedRetention(phase = "active", vmId = "vm-1") {
	await query(
		"insert into workspace_retention(session_id,user_id,vm_id,slug,resources,phase,last_activity_at) values($1,'alice',$2,$3,$4,$5,now()-interval '2 hours')",
		[session, vmId, slug, JSON.stringify(resources), phase],
	);
}

/** Everything admission decided, with generated ids replaced by their order. */
async function decisions() {
	const reservations = (
		await db.query<{
			id: string;
			user_id: string;
			resource_key: string;
			reserved_micro_usd: string;
			consumed_micro_usd: string | null;
		}>(
			"select id,user_id,resource_key,reserved_micro_usd::text,consumed_micro_usd::text from infrastructure_usage_reservation order by created_at,id",
		)
	).rows;
	const ids = new Map(reservations.map((row, index) => [row.id, `r${index}`]));
	const admission = (
		await db.query<Record<string, unknown>>(
			"select slug,user_id,reservation_id,max_run_total_seconds::text,baseline_seconds::text,hourly_micro_usd::text,vm_id from infrastructure_vm_admission",
		)
	).rows.map((row) => ({
		...row,
		reservation_id: ids.get(String(row.reservation_id)),
	}));
	const retention = (
		await db.query<Record<string, unknown>>(
			"select vm_id,phase,last_activity_at > now()-interval '1 minute' as touched from workspace_retention",
		)
	).rows;
	const leases = (await db.query("select slug from infrastructure_vm_lease"))
		.rows;
	return {
		reservations: reservations.map(({ id, ...row }) => ({
			id: ids.get(id),
			...row,
		})),
		admission,
		retention,
		leases,
	};
}
async function resume(vm: ReturnType<typeof machine>["vm"], seconds?: number) {
	const data = await vm.data();
	statements.length = 0;
	return admitVmResume(vm as never, data, seconds);
}
async function outcome(run: () => Promise<unknown>) {
	try {
		await run();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

it("keeps a running VM's covering cap without buying runtime", async () => {
	await seedAdmission({ cap: 1000, baseline: 100 });
	await seedRetention();
	const { vm, updates } = machine();
	expect(await outcome(() => resume(vm))).toBe(null);
	expect(updates).toEqual([]);
	expect(await decisions()).toMatchSnapshot();
	expect(statements.length).toMatchSnapshot("round trips");
});

it("tops up a running VM whose cap no longer covers the operation", async () => {
	await seedAdmission({ cap: 400, baseline: 100, ageSeconds: 250 });
	await seedRetention();
	const { vm, updates } = machine({ maxRunTotalSeconds: 400 });
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	expect(updates).toEqual([
		{ maxRunTotalSeconds: 700, automaticRestart: false },
	]);
	expect(await decisions()).toMatchSnapshot();
	expect(statements.length).toMatchSnapshot("round trips");
});

it("settles a paused VM and buys a fresh cap before resuming it", async () => {
	await seedAdmission({ cap: 900, baseline: 600 });
	await seedRetention();
	const { vm, updates } = machine({
		state: "paused",
		totalRunSeconds: 903,
		maxRunTotalSeconds: 900,
	});
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	expect(updates).toMatchSnapshot();
	expect(await decisions()).toMatchSnapshot();
	expect(statements.length).toMatchSnapshot("round trips");
});

it("admits a running VM that has no admission yet and enrolls its retention", async () => {
	const { vm, updates } = machine({ maxRunTotalSeconds: 0 });
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	expect(updates).toMatchSnapshot();
	expect(await decisions()).toMatchSnapshot();
	expect(statements.length).toMatchSnapshot("round trips");
});

it("does not enroll a VM created before the retention cutover", async () => {
	await seedAdmission({ cap: 1000, baseline: 100 });
	const { vm } = machine({ createdAt: "2025-06-01T00:00:00Z" });
	expect(await outcome(() => resume(vm))).toBe(null);
	expect((await decisions()).retention).toEqual([]);
});

it("refuses to resume a paused VM once a usage window is exhausted, unless a turn still runs", async () => {
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "10000");
	await seedAdmission({ cap: 900, baseline: 600 });
	await seedRetention();
	const { vm } = machine({
		state: "paused",
		totalRunSeconds: 903,
		maxRunTotalSeconds: 900,
	});
	// Settling the pause leaves 303 seconds (11,131 micro-USD) in the window.
	expect(await outcome(() => resume(vm, 60))).toMatch(
		/^You have reached your 5-hour cloud usage limit, so new work cannot start until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./,
	);
	// A turn of another session does not exempt this machine.
	await query(
		"insert into api_turn values('turn-0','alice','running','20000000-0000-4000-8000-000000000009')",
	);
	expect(await outcome(() => resume(vm, 60))).toMatch(/5-hour cloud usage/);
	// This session's own running turn does, below the hard ceiling.
	await query("insert into api_turn values('turn-1','alice','running',$1)", [
		session,
	]);
	expect(await outcome(() => resume(vm, 60))).toBe(null);
});

it("stops extending a running VM at the hard ceiling past an exhausted window", async () => {
	// The window is exhausted; the ceiling adds one hour (132,240) to it.
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "1000");
	await seedAdmission({ cap: 400, baseline: 100, ageSeconds: 250 });
	await seedRetention();
	const { vm } = machine({ maxRunTotalSeconds: 400 });
	// Exhausted, but under the ceiling: the running turn still gets runtime.
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	// Other work brings the window near the ceiling: no further extension.
	await query(
		"insert into infrastructure_usage_reservation(id,user_id,resource_key,period,reserved_micro_usd) values('10000000-0000-4000-8000-000000000002','alice','vm:other',date_trunc('month',now() at time zone 'utc')::date,115000)",
	);
	await query(
		"update infrastructure_vm_admission set updated_at=now()-interval '700 seconds'",
	);
	forgetRecentAdmission();
	expect(await outcome(() => resume(vm, 60))).toMatch(
		/^Running work has used the grace past your 5-hour cloud usage limit/,
	);
});

it("refuses a top-up past the fleet's monthly budget", async () => {
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "20000");
	await seedAdmission({ cap: 400, baseline: 100, ageSeconds: 250 });
	await seedRetention();
	const { vm, updates } = machine({ maxRunTotalSeconds: 400 });
	expect(await outcome(() => resume(vm, 60))).toBe(
		"The fleet cloud execution budget is exhausted.",
	);
	expect(updates).toEqual([]);
	expect(await decisions()).toMatchSnapshot();
});

it("refuses a top-up past the fleet's lifetime budget", async () => {
	vi.stubEnv("YTIMESY_FLEET_LIFETIME_MICRO_USD", "20000");
	await seedAdmission({ cap: 400, baseline: 100, ageSeconds: 250 });
	await seedRetention();
	const { vm } = machine({ maxRunTotalSeconds: 400 });
	expect(await outcome(() => resume(vm, 60))).toBe(
		"The lifetime fleet cloud execution budget is exhausted.",
	);
});

it("tops up a running VM past an exhausted usage window, so its turn finishes", async () => {
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "1000");
	vi.stubEnv("YTIMESY_USER_WEEKLY_MICRO_USD", "1000");
	await seedAdmission({ cap: 400, baseline: 100, ageSeconds: 250 });
	await seedRetention();
	const { vm, updates } = machine({ maxRunTotalSeconds: 400 });
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	expect(updates.at(-1)?.maxRunTotalSeconds).toBeGreaterThan(400);
});

it.each([
	["recovering retention", { phase: "capturing" }],
	// A stale caller: retention and the chat both moved to another VM.
	["rebound retention", { retentionVm: "vm-0", sessionVm: "vm-0" }],
	[
		"recovering retention on the chat's VM",
		{ phase: "capturing", retentionVm: "vm-0" },
	],
	["another owner", { userId: "bob" }],
	["another generation", { vmId: "vm-0" }],
	["changed resources", { hourlyMicroUsd: 1 }],
	["no owner", { noOwner: true }],
])(
	"refuses %s before touching the provider",
	async (_name, input: {
		phase?: string;
		retentionVm?: string;
		sessionVm?: string;
		userId?: string;
		vmId?: string;
		hourlyMicroUsd?: number;
		noOwner?: boolean;
	}) => {
		await seedAdmission({
			cap: 1000,
			baseline: 100,
			userId: input.userId,
			vmId: input.vmId,
			hourlyMicroUsd: input.hourlyMicroUsd,
		});
		await seedRetention(input.phase, input.retentionVm);
		if (input.sessionVm)
			await query("update agent_session set provider_ref=$1", [
				input.sessionVm,
			]);
		if (input.noOwner) await query("delete from agent_session");
		const { vm, updates } = machine();
		expect(await outcome(() => resume(vm))).toMatchSnapshot();
		expect(updates).toEqual([]);
		expect(await decisions()).toMatchSnapshot();
	},
);

it("rebinds retention left on a lost VM when the chat's current VM is admitted", async () => {
	await seedAdmission({ cap: 1000, baseline: 100 });
	// The chat names vm-1; retention still names the VM it replaced.
	await seedRetention("active", "vm-0");
	const { vm, updates } = machine();
	expect(await outcome(() => resume(vm))).toBe(null);
	expect(updates).toEqual([]);
	expect((await decisions()).retention).toEqual([
		{ vm_id: "vm-1", phase: "active", touched: true },
	]);
	// The next admission sees an ordinary bound row.
	forgetRecentAdmission();
	expect(await outcome(() => resume(vm))).toBe(null);
});

it("buys a new VM's cap before creating it and binds the VM after", async () => {
	const created: (number | undefined)[] = [];
	statements.length = 0;
	const freestyle = { vms: { ref: () => ({}) } } as unknown as Freestyle;
	expect(
		await admitVmCreate(
			freestyle,
			slug,
			CHEAP_BASE_SNAPSHOT,
			async (cap) => {
				created.push(cap);
				return "vm-new";
			},
			300,
		).catch((error: Error) => error.message),
	).toMatchSnapshot();
	expect(created).toMatchSnapshot();
	expect(await decisions()).toMatchSnapshot();
	expect(statements.length).toMatchSnapshot("round trips");
});

it("replays a reservation idempotently and refuses a changed identity", async () => {
	const id = "30000000-0000-4000-8000-000000000001";
	const input = {
		id,
		userId: "alice",
		resourceKey: "vm:x",
		amountMicroUsd: 1000,
	};
	await reserveInfrastructureUsage(input);
	await reserveInfrastructureUsage(input);
	expect(
		await outcome(() =>
			reserveInfrastructureUsage({ ...input, amountMicroUsd: 999 }),
		),
	).toBe("Infrastructure reservation identity changed.");
	expect(
		await outcome(() =>
			reserveInfrastructureUsage({
				...input,
				userId: "nobody",
				id: "30000000-0000-4000-8000-000000000002",
			}),
		),
	).toBe("Usage account is unavailable.");
	await reserveInfrastructureUsage(
		{ ...input, amountMicroUsd: 1500 },
		undefined,
		"increase",
	);
	await reserveInfrastructureUsage(
		{ ...input, amountMicroUsd: 1200 },
		undefined,
		"increase",
	);
	// Settling never refuses (a refusal once left a chat unable to wake its
	// VM): usage past the hold settles at the hold, and a later, different
	// settlement keeps the first.
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await settleInfrastructureUsage({
		id,
		userId: "alice",
		consumedMicroUsd: 1501,
	});
	await settleInfrastructureUsage({
		id,
		userId: "alice",
		consumedMicroUsd: 1500,
	});
	await settleInfrastructureUsage({
		id,
		userId: "alice",
		consumedMicroUsd: 600,
	});
	expect(warn.mock.calls.map(([message]) => message)).toEqual([
		"Infrastructure usage exceeded its hold; settled at the hold.",
		"Infrastructure hold was already settled; kept the first.",
	]);
	warn.mockRestore();
	expect(
		await outcome(() =>
			reserveInfrastructureUsage(input, undefined, "increase"),
		),
	).toBe("Infrastructure reservation is already settled.");
	expect(
		await outcome(() =>
			reserveInfrastructureUsage(
				{ ...input, id: "30000000-0000-4000-8000-000000000003" },
				undefined,
				"increase",
			),
		),
	).toBe("Infrastructure reservation is unavailable.");
	expect(await decisions()).toMatchSnapshot();
});

it("revokes first, then buys a fresh cap, when a paused VM's cap reaches past the new one", async () => {
	// 2000 - 903 seconds of prepaid runtime left: more than a resume buys.
	await seedAdmission({ cap: 2000, baseline: 600 });
	await seedRetention();
	const { vm, updates, state } = machine({
		state: "paused",
		totalRunSeconds: 903,
		maxRunTotalSeconds: 2000,
	});
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	expect(updates).toEqual([
		{ maxRunTotalSeconds: 903, automaticRestart: false },
		{ maxRunTotalSeconds: 1203, automaticRestart: false },
	]);
	const { reservations, admission } = await decisions();
	expect(reservations.map((row) => row.consumed_micro_usd)).toEqual([
		"11131",
		null,
	]);
	expect((admission[0] as Record<string, unknown>).max_run_total_seconds).toBe(
		"1203",
	);
	expect(state.maxRunTotalSeconds).toBe(1203);
});

it("a refused resume still settles the paused hold and revokes its cap, as before", async () => {
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "10000");
	await seedAdmission({ cap: 900, baseline: 600 });
	await seedRetention();
	const { vm, updates } = machine({
		state: "paused",
		totalRunSeconds: 903,
		maxRunTotalSeconds: 900,
	});
	expect(await outcome(() => resume(vm, 60))).toMatch(/5-hour cloud usage/);
	expect(updates).toEqual([
		{ maxRunTotalSeconds: 903, automaticRestart: false },
	]);
	const { reservations, admission } = await decisions();
	expect(reservations).toHaveLength(1);
	expect(reservations[0].consumed_micro_usd).toBe("11131");
	expect((admission[0] as Record<string, unknown>).max_run_total_seconds).toBe(
		"903",
	);
});

it("leaves a paused VM covered by its new hold when the single cap update fails", async () => {
	await seedAdmission({ cap: 900, baseline: 600 });
	await seedRetention();
	const { vm, state } = machine({
		state: "paused",
		totalRunSeconds: 850,
		maxRunTotalSeconds: 900,
	});
	vm.update = async () => {
		throw new Error("provider unavailable");
	};
	expect(await outcome(() => resume(vm, 60))).toBe("provider unavailable");
	const { reservations, admission } = await decisions();
	// The old hold settled at its use; the open new one pays up to 1150,
	// past the 900 the provider still allows.
	expect(reservations.map((row) => row.consumed_micro_usd)).toEqual([
		String(Math.ceil((250 * hourly) / 3600)),
		null,
	]);
	expect(
		Number((admission[0] as Record<string, unknown>).max_run_total_seconds),
	).toBeGreaterThanOrEqual(state.maxRunTotalSeconds);
	expect(
		Number((admission[0] as Record<string, unknown>).baseline_seconds),
	).toBe(850);
});

it("takes the cap update's own answer as its confirmation, and re-reads only when it does not show the cap", async () => {
	await seedAdmission({ cap: 900, baseline: 600 });
	await seedRetention();
	const { vm, state } = machine({
		state: "paused",
		totalRunSeconds: 903,
		maxRunTotalSeconds: 900,
	});
	const read = vm.data;
	let reads = 0;
	vm.data = async () => {
		reads++;
		return read();
	};
	const update = vm.update;
	vm.update = async (patch: Partial<Provider>) => {
		await update(patch);
		return { ...state, slug, resources } as never;
	};
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	// One read before the lease (resume's), one under it; none after the update.
	expect(reads).toBe(2);
	vm.update = async (patch: Partial<Provider>) => {
		await update(patch);
		return { ...state, maxRunTotalSeconds: 1 } as never;
	};
	state.state = "paused";
	state.totalRunSeconds = 1150;
	reads = 0;
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	expect(reads).toBe(3);
});

it("lets the operations right after a wake reuse its admission once the machine runs", async () => {
	await seedAdmission({ cap: 900, baseline: 600 });
	await seedRetention();
	const { vm, state } = machine({
		state: "paused",
		totalRunSeconds: 903,
		maxRunTotalSeconds: 900,
	});
	expect(await outcome(() => resume(vm, 60))).toBe(null);
	const read = await vm.data();
	// Still paused: not covered.
	expect(recentAdmissionCovers(read, 60)).toBe(false);
	state.state = "running";
	expect(recentAdmissionCovers(await vm.data(), 60)).toBe(true);
	// Past the bought runtime, or another cap: admitted again.
	expect(recentAdmissionCovers(await vm.data(), 300)).toBe(false);
	state.maxRunTotalSeconds = 2000;
	expect(recentAdmissionCovers(await vm.data(), 60)).toBe(false);
});
