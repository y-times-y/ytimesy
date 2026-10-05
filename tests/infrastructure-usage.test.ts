import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Freestyle, VmData } from "freestyle";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { utcUsageMonth } from "../src/domain/infrastructure-usage";
import {
	admitVmCreate,
	admitVmResume,
	reconcilePausedVm,
} from "../src/server/adapters/freestyle/usage-admission";
import {
	adjustInfrastructureAllowance,
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
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values('alice'),('bob'),('admin'); create table workspace(id text,user_id text); create table agent_session(id text,user_id text); create table environment_build(id text,workspace_id text); insert into workspace values('one','alice'); insert into environment_build values('build-one','one');",
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
});
beforeEach(async () => {
	vi.stubEnv("YTIMESY_ADMIN_USER_IDS", "admin");
	vi.stubEnv("YTIMESY_USER_MONTHLY_MICRO_USD", "100");
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "150");
	vi.stubEnv("YTIMESY_FLEET_LIFETIME_MICRO_USD", "1000");
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	await db.exec(
		"truncate infrastructure_vm_admission,infrastructure_usage_reservation,infrastructure_usage_adjustment,infrastructure_usage_policy;",
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
	vi.stubEnv("YTIMESY_USER_MONTHLY_MICRO_USD", "66120");
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
		admitVmCreate(client, "ytimesy-ws-one", "freestyle/ubuntu-sm", uncertain),
	).rejects.toThrow("uncertain");
	await admitVmCreate(client, "ytimesy-ws-one", "freestyle/ubuntu-sm", create);
	expect(create).toHaveBeenCalledWith(300);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(13224);
	await expect(
		admitVmCreate(client, "ytimesy-ws-one", "freestyle/ubuntu-sm", create),
	).rejects.toThrow("generation changed");
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(13224);
	await expect(
		admitVmCreate(client, "unknown", "freestyle/ubuntu-sm", create),
	).rejects.toThrow("owner");
	expect(create).toHaveBeenCalledTimes(1);
});

it("reserves the larger requested copy shape before provisioning", async () => {
	enableVmAllowance();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-one",
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
		"ytimesy-ws-one",
		"freestyle/ubuntu-sm",
		async () => "vm",
	);
	const data = {
		id: "vm",
		slug: "ytimesy-ws-one",
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
			"ytimesy-ws-one",
			"freestyle/ubuntu-sm",
			async () => "vm",
		);
		const data = {
			id: "vm",
			slug: "ytimesy-ws-one",
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

it("does not call the VM creator when spending would exceed the fleet ceiling", async () => {
	enableVmAllowance();
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "1");
	const create = vi.fn(async () => "vm");
	await expect(
		admitVmCreate(
			{} as Freestyle,
			"ytimesy-ws-one",
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
		"ytimesy-ws-one",
		"freestyle/ubuntu-sm",
		async () => "vm",
	);
	await db.exec(
		"update infrastructure_vm_admission set updated_at=now()-interval '4 minutes'",
	);
	const data = {
		id: "vm",
		slug: "ytimesy-ws-one",
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

it("resolves setup ownership through the workspace and limits long preparation to available credit", async () => {
	enableVmAllowance();
	const create = vi.fn(async (_cap?: number) => "build-vm");
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-build-build-one",
		"freestyle/ubuntu-sm",
		create,
		3600,
	);
	expect(create).toHaveBeenCalledWith(1740);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(66120);
});

it("retains a paused hold if the provider fails to confirm revocation", async () => {
	enableVmAllowance();
	await admitVmCreate(
		{} as Freestyle,
		"ytimesy-ws-one",
		"freestyle/ubuntu-sm",
		async () => "vm",
	);
	const data = {
		id: "vm",
		slug: "ytimesy-ws-one",
		state: "paused",
		totalRunSeconds: 23,
		maxRunTotalSeconds: 300,
	} as VmData;
	const vm = { data: async () => data, update: async () => {} };
	await expect(
		reconcilePausedVm(vm as unknown as ReturnType<Freestyle["vms"]["ref"]>),
	).rejects.toThrow("confirmed");
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(13224);
});

it.each([0, 23])(
	"revokes the remaining provider cap before refunding a paused VM with %i seconds, then permits funded resume",
	async (runtime) => {
		enableVmAllowance();
		await admitVmCreate(
			{} as Freestyle,
			"ytimesy-ws-one",
			"freestyle/ubuntu-sm",
			async () => "vm",
		);
		const data = {
			id: "vm",
			slug: "ytimesy-ws-one",
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
		slug: "ytimesy-ws-one",
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

it("shares one allowance across child VMs and rejects admission without adding a row", async () => {
	await reserveInfrastructureUsage(reservation());
	await expect(
		reserveInfrastructureUsage({ ...reservation(), resourceKey: "vm:two" }),
	).rejects.toThrow("allowance is exhausted");
	expect(await userInfrastructureUsage("alice")).toMatchObject({
		consumedMicroUsd: 0,
		reservedMicroUsd: 60,
		remainingMicroUsd: 40,
	});
	expect(await userInfrastructureUsage("bob")).toMatchObject({
		reservedMicroUsd: 0,
		remainingMicroUsd: 100,
	});
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
it("settles once, releases only verified unused usage, and refuses overspend or replay", async () => {
	const hold = reservation();
	await reserveInfrastructureUsage(hold);
	await expect(
		settleInfrastructureUsage({
			id: hold.id,
			userId: "bob",
			consumedMicroUsd: 20,
		}),
	).rejects.toThrow();
	await expect(
		settleInfrastructureUsage({
			id: hold.id,
			userId: "alice",
			consumedMicroUsd: 61,
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
	await expect(
		settleInfrastructureUsage({
			id: hold.id,
			userId: "alice",
			consumedMicroUsd: 0,
		}),
	).rejects.toThrow("changed after confirmation");
	await expect(reserveInfrastructureUsage(hold)).rejects.toThrow(
		"already settled",
	);
	expect(await userInfrastructureUsage("alice")).toMatchObject({
		consumedMicroUsd: 20,
		reservedMicroUsd: 0,
		remainingMicroUsd: 80,
	});
});
it("permits audited admin grants including self, but never bypasses the fleet budget", async () => {
	const grant = {
		id: randomUUID(),
		actorId: "admin",
		userId: "admin",
		kind: "grant" as const,
		amountMicroUsd: 100,
		reason: "Dogfood testing",
	};
	await expect(
		adjustInfrastructureAllowance({ ...grant, actorId: "alice" }),
	).rejects.toBeInstanceOf(Response);
	await adjustInfrastructureAllowance(grant);
	await adjustInfrastructureAllowance(grant);
	expect((await userInfrastructureUsage("admin")).allowanceMicroUsd).toBe(200);
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
	).toEqual([{ count: 1 }]);
});
it("sets a persistent monthly override without deleting prior consumption", async () => {
	await reserveInfrastructureUsage(reservation());
	await adjustInfrastructureAllowance({
		id: randomUUID(),
		actorId: "admin",
		userId: "alice",
		kind: "monthly_limit",
		amountMicroUsd: 20,
		reason: "Reduced allocation",
	});
	expect(await userInfrastructureUsage("alice")).toMatchObject({
		allowanceMicroUsd: 20,
		reservedMicroUsd: 60,
		remainingMicroUsd: 0,
	});
});
it("carries uncertain reservations across month boundaries", async () => {
	await reserveInfrastructureUsage(reservation());
	await query(
		"update infrastructure_usage_reservation set period='2020-01-01'",
	);
	expect((await userInfrastructureUsage("alice")).reservedMicroUsd).toBe(60);
	await expect(reserveInfrastructureUsage(reservation())).rejects.toThrow(
		"allowance",
	);
});
it("fails closed on invalid configuration and unknown users", async () => {
	await expect(
		reserveInfrastructureUsage(reservation("missing")),
	).rejects.toThrow("unavailable");
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
