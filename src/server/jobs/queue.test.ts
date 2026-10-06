import type { ConstructorOptions } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	instances: [] as {
		options: ConstructorOptions;
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		createQueue: ReturnType<typeof vi.fn>;
		updateQueue: ReturnType<typeof vi.fn>;
	}[],
	start: async () => {},
	query: vi.fn(async () => ({ rows: [] })),
}));
vi.mock("pg-boss", () => ({
	PgBoss: class {
		start = vi.fn(() => fake.start());
		stop = vi.fn(async () => {});
		createQueue = vi.fn(async () => {});
		updateQueue = vi.fn(async () => {});
		on = vi.fn();
		constructor(public options: ConstructorOptions) {
			fake.instances.push(this);
		}
	},
}));
vi.mock("../adapters/database", () => ({
	database: () => ({ query: fake.query }),
}));

afterEach(async () => {
	await (await import("./queue")).closeJobQueueForTests();
	fake.instances = [];
	fake.start = async () => {};
	vi.resetModules();
	vi.clearAllMocks();
});

describe("job queue connection lifecycle", () => {
	it("shares one initialized producer across 10,000 simultaneous callers", async () => {
		const { jobQueue } = await import("./queue");
		const queues = await Promise.all(
			Array.from({ length: 10_000 }, () => jobQueue()),
		);
		expect(new Set(queues).size).toBe(1);
		expect(fake.instances).toHaveLength(1);
		expect(fake.instances[0].start).toHaveBeenCalledOnce();
	});
	it("uses the shared database and reserves maintenance for the worker", async () => {
		const { jobQueue } = await import("./queue");
		await jobQueue();
		await jobQueue("worker");
		const [producer, worker] = fake.instances;
		expect(producer.updateQueue).not.toHaveBeenCalled();
		expect(worker.updateQueue).toHaveBeenCalledWith("prepare-workspace", {
			expireInSeconds: 4500,
		});
		expect(worker.updateQueue).toHaveBeenCalledWith(
			"refresh-workspace-snapshot",
			{ expireInSeconds: 4500 },
		);
		expect(producer.options).toMatchObject({
			schedule: false,
			supervise: false,
			migrate: false,
			useListenNotify: false,
		});
		expect(worker.options).toMatchObject({
			schedule: true,
			supervise: true,
			migrate: true,
			useListenNotify: false,
		});
		expect(producer.options.connectionString).toBeUndefined();
		expect(worker.options.connectionString).toBeUndefined();
		await producer.options.db?.executeSql("select $1", [1]);
		expect(fake.query).toHaveBeenCalledWith("select $1", [1]);
	});
	it("reuses the same queue across server module reloads", async () => {
		const first = await (await import("./queue")).jobQueue();
		vi.resetModules();
		const second = await (await import("./queue")).jobQueue();
		expect(second).toBe(first);
		expect(fake.instances).toHaveLength(1);
	});
	it("makes concurrent callers wait for startup and queue creation", async () => {
		let release!: () => void;
		fake.start = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const { jobQueue } = await import("./queue");
		const first = jobQueue();
		let secondReady = false;
		const second = jobQueue().then((queue) => {
			secondReady = true;
			return queue;
		});
		await Promise.resolve();
		const premature = secondReady;
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(premature).toBe(false);
		expect(a).toBe(b);
		expect(fake.instances[0].createQueue).toHaveBeenCalledTimes(8);
		expect(fake.instances[0].createQueue).toHaveBeenCalledWith(
			"durable-work-plan",
			expect.objectContaining({ policy: "singleton", expireInSeconds: 1800 }),
		);
		expect(fake.instances[0].createQueue).toHaveBeenCalledWith(
			"pr-repair",
			expect.any(Object),
		);
		expect(fake.instances[0].createQueue).toHaveBeenCalledWith(
			"agent-peer-message",
			{
				policy: "singleton",
				retryLimit: 5760,
				retryDelay: 15,
				retryBackoff: false,
				expireInSeconds: 1800,
			},
		);
	});
	it("closes a failed startup and lets the next request retry", async () => {
		fake.start = async () => {
			throw new Error("offline");
		};
		const { jobQueue } = await import("./queue");
		await expect(jobQueue()).rejects.toThrow("offline");
		expect(fake.instances[0].stop).toHaveBeenCalledOnce();
		fake.start = async () => {};
		await jobQueue();
		expect(fake.instances).toHaveLength(2);
	});
});
