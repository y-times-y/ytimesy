import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	failureDigest,
	gpuHostBilling,
	type HostOps,
	loadTasks,
	tick,
} from "../scripts/tb4-run/controller.ts";
import {
	awsGpuHostHourly,
	gpuTaskSpec,
	hostWorstCaseUsd,
	worstCaseUsd,
} from "../scripts/tb4-run/gpu-cost.ts";
import {
	classifyGpuTrial,
	type GpuLaneOps,
	type GpuTarget,
	gpuLaneAlerts,
	gpuLaneTick,
	type LaneEvent,
	type LiveSandbox,
	laneConfig,
	type LaneConfig,
	laneHost,
	readBudget,
	spentEstimate,
	writeBudget,
} from "../scripts/tb4-run/gpu-lane.ts";
import {
	type HarborResult,
	type HostObservation,
	Journal,
	replay,
	reviewConfig,
	scoredTrials,
	type Task,
	taskFromToml,
} from "../scripts/tb4-run/lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/*
 * The resource and time-limit lines of the three TB4 GPU task.toml files
 * (terminal-bench@4.0.0, Harbor 0.24.0), copied verbatim; everything else in them
 * is irrelevant to cost. TB4_GPU_TASK_DATASET=<dir with <task>/task.toml> also checks
 * the real files (`uvx --from harbor==0.24.0 harbor download terminal-bench/<task>`).
 */
const TOML = {
	"fp8-rmsnorm-gemm": `
[verifier]
environment_mode = "separate"
timeout_sec = 18000.0
[verifier.environment]
cpus = 4
memory_mb = 16384
storage_mb = 30720
gpus = 1
[agent]
timeout_sec = 28800.0
[environment]
cpus = 4
memory_mb = 16384
storage_mb = 30720
gpus = 1
`,
	"math-eval-grader": `
[agent]
timeout_sec = 28800.0
[verifier]
timeout_sec = 900.0
environment_mode = "separate"
[verifier.environment]
cpus = 8
memory_mb = 16384
storage_mb = 30720
gpus = 1
[environment]
cpus = 8
memory_mb = 16384
storage_mb = 30720
gpus = 1
`,
	"jax-speedrun-gpu": `
[verifier]
timeout_sec = 7200.0
environment_mode = "separate"
[verifier.environment]
cpus = 16
memory_mb = 32768
storage_mb = 1024000
gpus = 1
[agent]
timeout_sec = 28800.0
[environment]
cpus = 16
memory_mb = 32768
storage_mb = 1024000
gpus = 1
`,
};
function datasetDir() {
	const root = mkdtempSync(join(tmpdir(), "tb4gputasks-"));
	for (const [name, toml] of Object.entries(TOML)) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "task.toml"), toml);
	}
	return root;
}
const gpuTasks = loadTasks(datasetDir());
const byName = (n: string) => gpuTasks.find((t) => t.name === n)!;

describe("tb4 GPU lane cost model", () => {
	it("worst case from the task.toml limits (Daytona per sandbox, AWS per host-hour)", () => {
		const raw = (n: string) => worstCaseUsd(byName(n).gpuSpec!, 0).usd;
		// Daytona: H100 $2.27 + vCPU $0.0504 + GiB $0.0162 + storage over 5 GiB $0.000108, per hour.
		expect(raw("fp8-rmsnorm-gemm")).toBeCloseTo(13 * 2.7335, 2); // 8 h agent + 5 h verifier
		expect(raw("math-eval-grader")).toBeCloseTo(8.25 * 2.9351, 2);
		expect(raw("jax-speedrun-gpu")).toBeCloseTo(10 * 3.70226, 2); // 1000 GiB disk
		// With the default 10 min allowance per sandbox.
		const w = (n: string) => worstCaseUsd(byName(n).gpuSpec!).usd;
		expect(w("fp8-rmsnorm-gemm")).toBeCloseTo(36.45, 1);
		expect(w("math-eval-grader")).toBeCloseTo(25.19, 1);
		expect(w("jax-speedrun-gpu")).toBeCloseTo(38.26, 1);
		// AWS p5.4xlarge (1 H100), $5.97/h on-demand and Capacity Block.
		const p5 = awsGpuHostHourly("p5.4xlarge", "on-demand");
		expect(p5).toBe(5.97);
		expect(awsGpuHostHourly("p5.4xlarge", "capacity-block")).toBe(5.97);
		expect(
			awsGpuHostHourly("p5.4xlarge", "on-demand", {
				TB4_P5_4XL_HOURLY_USD: "6.5",
			}),
		).toBe(6.5);
		expect(
			hostWorstCaseUsd(byName("fp8-rmsnorm-gemm").gpuSpec!, p5, 0).usd,
		).toBeCloseTo(77.61, 2);
		expect(
			hostWorstCaseUsd(byName("jax-speedrun-gpu").gpuSpec!, p5).usd,
		).toBeCloseTo(61.69, 1);
		// A CPU task has no GPU spec and keeps its old tasks.json shape.
		expect(
			taskFromToml("c", { environment: { cpus: 2 } }).gpuSpec,
		).toBeUndefined();
		expect(gpuTaskSpec({ environment: { cpus: 2 } })).toBeNull();
	});

	it.skipIf(!process.env.TB4_GPU_TASK_DATASET)(
		"the real downloaded task.toml files give the same numbers",
		() => {
			const real = loadTasks(process.env.TB4_GPU_TASK_DATASET!);
			for (const t of gpuTasks) {
				const r = real.find((x) => x.name === t.name);
				expect(r?.gpuSpec).toEqual(t.gpuSpec);
			}
		},
	);
});

/* ---------- a fake lane ---------- */

const H100_LOG = (id: string, role = "agent", at = "2026-10-29T00:00:00Z") => [
	JSON.stringify({
		at,
		event: "create",
		id,
		role,
		cpus: 4,
		memoryGiB: 16,
		storageGiB: 30,
		gpus: 1,
	}),
	JSON.stringify({
		at,
		event: "gpu-assert",
		id,
		role,
		gpu: "NVIDIA H100 80GB HBM3",
	}),
];
const graded = (reward: number): HarborResult => ({
	agent_execution: { started_at: "2026-10-29T00:01:00Z" },
	verifier_result: { rewards: { reward } },
	evidence: { bridgeLog: true, providerFailures: 0 },
});

type Script = {
	/** Per attempt (called once per observe): "pending", or the finished trial's result. */
	trial: (id: string) => "pending" | { result?: HarborResult };
	/** The attempt's daytona-sandboxes.jsonl (default: an H100 agent sandbox). */
	log?: (id: string) => string[];
	live?: () => LiveSandbox[];
};
function fakeLane(target: GpuTarget, script: Script) {
	const launched: string[] = [];
	const deleted: string[] = [];
	const ops: GpuLaneOps = {
		target,
		launch: (id) => void launched.push(id),
		observe: (id): HostObservation => {
			const s = script.trial(id);
			if (s === "pending")
				return {
					processAlive: true,
					hostReachable: true,
					hostRebootedSinceLaunch: false,
				};
			return {
				result: s.result,
				processAlive: false,
				hostReachable: true,
				hostRebootedSinceLaunch: false,
			};
		},
		collect: () => ["controller:x"],
		sandboxLog: (id) => script.log?.(id) ?? H100_LOG(`sb-${id}`),
		liveSandboxes: () => ({ ok: true, sandboxes: script.live?.() ?? [] }),
		deleteSandboxes: (ids) => {
			deleted.push(...ids);
			return "deleted";
		},
	};
	return { ops, launched, deleted };
}
function newRun() {
	const dir = mkdtempSync(join(tmpdir(), "tb4gpu-"));
	const journal = new Journal(join(dir, "journal.jsonl"));
	journal.append({
		at: "t",
		type: "run-start",
		runId: "r",
		commit: "c",
		bundleSha256: "0".repeat(64),
	});
	journal.append({ at: "t", type: "batch-open", batch: "b1" });
	journal.append({ at: "t", type: "batch-open", batch: "b2" });
	return {
		dir,
		journal,
		lane: new Journal<LaneEvent>(join(dir, "gpu-lane-journal.jsonl")),
	};
}
const noStage1 = reviewConfig({ TB4_STAGE1: "off" });
const cfg = laneConfig({}, false);
const daytona: GpuTarget = { kind: "daytona" };
let minute = 0;
const clock = () => new Date(Date.UTC(2026, 9, 29, 0, minute++)).toISOString();

function laneTick(
	run: ReturnType<typeof newRun>,
	ops: GpuLaneOps,
	extra: { budgetUsd?: number; tasks?: Task[]; config?: LaneConfig } = {},
) {
	if (extra.budgetUsd !== undefined)
		writeBudget(run.dir, { budgetUsd: extra.budgetUsd });
	return gpuLaneTick({
		journal: run.journal,
		lane: run.lane,
		tasks: extra.tasks ?? gpuTasks,
		ops,
		budget: readBudget(run.dir, {}),
		config: extra.config ?? cfg,
		review: noStage1,
		now: clock,
	});
}

describe("tb4 GPU lane", () => {
	it("pauses when the worst case does not fit the budget, alerts, and resumes after the operator raises it", () => {
		const run = newRun();
		const { ops, launched } = fakeLane(daytona, { trial: () => "pending" });
		// fp8 worst case $36.45 + $5 buffer > $30.
		let log = laneTick(run, ops, { budgetUsd: 30 });
		expect(launched).toEqual([]);
		expect(
			log.some((l) => l.startsWith("GPU-PAUSE r-b1-fp8-rmsnorm-gemm-a01")),
		).toBe(true);
		laneTick(run, ops); // same numbers: journaled once
		const pauses = run.lane.events().filter((e) => e.type === "gpu-pause");
		expect(pauses).toHaveLength(1);
		expect(pauses[0]).toMatchObject({
			budgetUsd: 30,
			spentUsd: 0,
			needUsd: 11.45,
		});
		const alerts = gpuLaneAlerts(run.lane.events());
		expect(alerts[0]).toMatchObject({ level: "critical" });
		expect(alerts[0].text).toContain("add budget to continue: need $11.45");
		// No budget at all (or an unreadable file) also pauses: never "unlimited".
		writeFileSync(join(run.dir, "gpu-budget.json"), "{oops");
		expect(
			readBudget(run.dir, { TB4_GPU_BUDGET_USD: "500" }).budgetUsd,
		).toBeNull();
		expect(
			readBudget(mkdtempSync(join(tmpdir(), "e-")), {
				TB4_GPU_BUDGET_USD: "500",
			}).budgetUsd,
		).toBe(500);
		log = laneTick(run, ops);
		expect(launched).toEqual([]);
		// The operator raises it while the controller runs; the next tick re-reads the file.
		log = laneTick(run, ops, { budgetUsd: 100 });
		expect(launched).toEqual(["r-b1-fp8-rmsnorm-gemm-a01"]);
		const ev = run.lane.events();
		expect(ev.some((e) => e.type === "gpu-resume")).toBe(true);
		expect(ev.at(-1)).toMatchObject({
			type: "gpu-launch",
			worstCaseUsd: 36.45,
			budgetUsd: 100,
		});
		expect(gpuLaneAlerts(ev)).toEqual([]);
		expect(
			replay(run.journal.events()).attempts.get("r-b1-fp8-rmsnorm-gemm-a01")
				?.host,
		).toBe("gpu-lane:daytona");
	});

	it("counts spent from sandbox lifetimes and pauses before the trial that would pass the budget", () => {
		const run = newRun();
		// Each fp8 trial: agent 2 h, verifier 1 h at $2.7335/h = $8.20.
		const log = (id: string) => [
			...H100_LOG(`a-${id}`, "agent", "2026-10-29T00:00:00Z"),
			JSON.stringify({
				at: "2026-10-29T02:00:00Z",
				event: "delete",
				id: `a-${id}`,
			}),
			JSON.stringify({
				at: "2026-10-29T02:00:30Z",
				event: "gone",
				id: `a-${id}`,
			}),
			...H100_LOG(`v-${id}`, "verifier", "2026-10-29T02:00:30Z"),
			JSON.stringify({
				at: "2026-10-29T03:00:30Z",
				event: "gone",
				id: `v-${id}`,
			}),
		];
		const { ops, launched } = fakeLane(daytona, {
			trial: () => ({ result: graded(1) }),
			log: () => log("x"),
		});
		// $55: trial 1 fits (0 + 36.45 + 5); after it, 8.20 + 36.45 + 5 = 49.65 fits; after two, 57.85 does not.
		for (let i = 0; i < 6; i++) laneTick(run, ops, { budgetUsd: 55 });
		expect(launched).toEqual([
			"r-b1-fp8-rmsnorm-gemm-a01",
			"r-b2-fp8-rmsnorm-gemm-a01",
		]);
		const ev = run.lane.events();
		const spent = spentEstimate(ev, readBudget(run.dir, {}));
		expect(spent).toBeCloseTo(2 * 3 * 2.7335 + 2 * (30 / 3600) * 2.7335, 2);
		expect(ev.filter((e) => e.type === "gpu-pause").at(-1)).toMatchObject({
			attemptId: "r-b2-fp8-rmsnorm-gemm-a02",
		});
		// An actual figure replaces the estimate up to its time: the operator says $10 so far.
		writeBudget(run.dir, {
			actualSpentUsd: 10,
			actualAt: "2026-10-29T05:00:00Z",
		});
		expect(spentEstimate(ev, readBudget(run.dir, {}))).toBe(10);
		laneTick(run, ops);
		expect(launched).toHaveLength(3); // 10 + 36.45 + 5 <= 55
	});

	it("runs strictly one trial at a time, waits for the last verifier sandbox to be gone, in task order", () => {
		const run = newRun();
		const state = new Map<string, number>();
		let verifierLingers = false;
		const { ops, launched, deleted } = fakeLane(daytona, {
			trial: (id) => {
				const n = state.get(id) ?? 0;
				state.set(id, n + 1);
				return n < 2 ? "pending" : { result: graded(1) };
			},
			live: () =>
				verifierLingers
					? [
							{
								id: "v-old",
								state: "destroying",
								gpus: 1,
								cpus: 4,
								memoryGiB: 16,
								storageGiB: 30,
								lane: false,
							},
						]
					: [],
		});
		laneTick(run, ops, { budgetUsd: 10_000 });
		laneTick(run, ops);
		laneTick(run, ops);
		expect(launched).toEqual(["r-b1-fp8-rmsnorm-gemm-a01"]); // still in flight
		verifierLingers = true;
		laneTick(run, ops); // collects a01; a GPU sandbox it did not create is still listed
		laneTick(run, ops);
		expect(launched).toHaveLength(1);
		expect(deleted).toEqual([]);
		expect(gpuLaneAlerts(run.lane.events())[0].key).toBe("gpu-blocked:v-old");
		verifierLingers = false;
		for (let i = 0; i < 60; i++) laneTick(run, ops);
		const tasksInOrder = launched.map((id) =>
			id.replace(/^r-b[12]-/, "").replace(/-a\d\d$/, ""),
		);
		expect(tasksInOrder).toEqual([
			...Array(5).fill("fp8-rmsnorm-gemm"),
			...Array(5).fill("math-eval-grader"),
			...Array(5).fill("jax-speedrun-gpu"),
		]);
		// Never two in flight: every launch comes after the previous attempt's finish.
		const events = run.journal.events();
		let open = 0;
		for (const e of events) {
			if (e.type === "launch") open++;
			if (e.type === "finish") open--;
			expect(open).toBeLessThanOrEqual(1);
		}
		expect(laneTick(run, ops).at(-1)).toContain("lane done");
	});

	it("under the stage-1 hold, runs every task's batch-1 trial before waiting", () => {
		const run = newRun();
		const { ops, launched } = fakeLane(daytona, {
			trial: () => ({ result: graded(1) }),
		});
		const stage1 = laneConfig({}, true);
		laneTick(run, ops, { budgetUsd: 10_000, config: stage1 });
		let last: string[] = [];
		for (let i = 0; i < 30; i++) last = laneTick(run, ops, { config: stage1 });
		expect(launched).toEqual([
			"r-b1-fp8-rmsnorm-gemm-a01",
			"r-b1-math-eval-grader-a01",
			"r-b1-jax-speedrun-gpu-a01",
		]);
		expect(last.join("\n")).toContain("waits for `controller.ts ack stage1`");
	});

	it("deletes leftover lane sandboxes (and charges them) before launching", () => {
		const run = newRun();
		let leftover = true;
		const { ops, launched, deleted } = fakeLane(daytona, {
			trial: () => "pending",
			live: () =>
				leftover
					? [
							{
								id: "orphan-1",
								state: "started",
								gpus: 1,
								cpus: 4,
								memoryGiB: 16,
								storageGiB: 30,
								lane: true,
								attemptId: "r-b1-x-a01",
								createdAt: "2026-10-28T23:00:00Z",
							},
						]
					: [],
		});
		laneTick(run, ops, { budgetUsd: 10_000 });
		expect(deleted).toEqual(["orphan-1"]);
		expect(launched).toEqual([]);
		expect(
			run.lane.events().find((e) => e.type === "gpu-orphans"),
		).toMatchObject({ ids: ["orphan-1"] });
		leftover = false;
		laneTick(run, ops);
		expect(launched).toHaveLength(1);
	});

	it("a preempted sandbox is infra: rerun, not scored, and the rerun counts toward spend", () => {
		const run = newRun();
		const preempted = [
			...H100_LOG("a1"),
			JSON.stringify({
				at: "2026-10-29T01:00:00Z",
				event: "lost",
				id: "a1",
				role: "agent",
				state: "stopped",
			}),
			JSON.stringify({
				at: "2026-10-29T01:00:00Z",
				event: "delete",
				id: "a1",
				role: "agent",
			}),
		];
		const { ops, launched } = fakeLane(daytona, {
			// The verifier graded an empty /app: reward 0, but the agent sandbox was taken away.
			trial: (id) => ({ result: graded(id.endsWith("a01") ? 0 : 1) }),
			log: (id) => (id.endsWith("a01") ? preempted : H100_LOG(id)),
		});
		const fp8 = [byName("fp8-rmsnorm-gemm")];
		laneTick(run, ops, { budgetUsd: 10_000, tasks: fp8 });
		// Like any infra end on the CPU lane, it holds launches until the operator reads it.
		expect(
			laneTick(run, ops, { tasks: fp8 }).some((l) =>
				l.startsWith(
					"REVIEW r-b1-fp8-rmsnorm-gemm-a01: infra:Daytona agent sandbox stopped",
				),
			),
		).toBe(true);
		expect(launched).toHaveLength(1);
		run.journal.append({
			at: clock(),
			type: "ack",
			key: "r-b1-fp8-rmsnorm-gemm-a01",
			note: "read: Daytona preempted the agent sandbox; rerun",
		});
		laneTick(run, ops, { tasks: fp8 });
		const s = replay(run.journal.events());
		expect(s.attempts.get("r-b1-fp8-rmsnorm-gemm-a01")).toMatchObject({
			outcome: {
				kind: "infra",
				reason: expect.stringContaining("preempted or killed by the provider"),
			},
			cause: {
				cause: expect.stringMatching(/^infra:Daytona agent sandbox stopped/),
			},
		});
		expect(launched).toEqual([
			"r-b1-fp8-rmsnorm-gemm-a01",
			"r-b1-fp8-rmsnorm-gemm-a02",
		]);
		expect(scoredTrials(s).get("fp8-rmsnorm-gemm")?.scored ?? []).toHaveLength(
			0,
		);
		const spend = run.lane.events().find((e) => e.type === "gpu-spend");
		expect(spend?.usd).toBeCloseTo(2.7335, 3); // 1 h of the preempted agent sandbox
		// Other Daytona failures: the GPU limit, an exception naming a lost sandbox, no H100.
		expect(
			classifyGpuTrial(
				daytona,
				{
					agent_execution: { started_at: null },
					exception_info: {
						exception_type: "DaytonaError",
						exception_message: "Total GPU limit exceeded",
					},
				},
				[],
			),
		).toMatchObject({
			kind: "infra",
			reason: expect.stringContaining("GPU limit"),
		});
		expect(
			classifyGpuTrial(
				daytona,
				{
					...graded(0),
					exception_info: {
						exception_type: "RuntimeError",
						exception_message: "Sandbox is not running",
					},
				},
				H100_LOG("z"),
			),
		).toMatchObject({
			kind: "infra",
			reason: expect.stringContaining("Daytona sandbox lost"),
		});
		expect(classifyGpuTrial(daytona, graded(1), [])).toMatchObject({
			kind: "infra",
			reason: expect.stringContaining("no NVIDIA H100 asserted"),
		});
		expect(classifyGpuTrial(daytona, graded(0), H100_LOG("ok"))).toMatchObject({
			kind: "valid",
			reward: 0,
		});
	});

	it("journal compatibility: the run journal holds lane trials like CPU ones; the CPU tick leaves them to the lane", () => {
		const run = newRun();
		const { ops } = fakeLane(daytona, { trial: () => ({ result: graded(1) }) });
		laneTick(run, ops, { budgetUsd: 10_000 });
		laneTick(run, ops);
		const s = replay(run.journal.events());
		const a = s.attempts.get("r-b1-fp8-rmsnorm-gemm-a01")!;
		expect(a).toMatchObject({
			status: "finished",
			outcome: { kind: "valid", reward: 1 },
			copies: ["controller:x"],
		});
		expect(scoredTrials(s).get("fp8-rmsnorm-gemm")?.scored).toHaveLength(1);
		// A CPU tick with no lane configured never marks a lane attempt infra
		// ("host no longer in the fleet"), and does not schedule anything on a lane host.
		const pending = newRun();
		pending.journal.append({
			at: "t",
			type: "launch",
			attemptId: "r-b1-math-eval-grader-a01",
			task: "math-eval-grader",
			batch: "b1",
			host: laneHost(daytona),
		});
		const cpuOps: HostOps = {
			launch: () => {},
			observe: () => ({
				processAlive: false,
				hostReachable: true,
				hostRebootedSinceLaunch: false,
			}),
			collect: () => [],
			health: () => ({ ok: true, why: "" }),
		};
		tick({
			runDir: pending.dir,
			journal: pending.journal,
			hosts: [],
			tasks: gpuTasks,
			ops: cpuOps,
			review: noStage1,
		});
		expect(
			replay(pending.journal.events()).attempts.get("r-b1-math-eval-grader-a01")
				?.status,
		).toBe("launched");
		// A non-benign end holds the lane (and the CPU lane) until acked, with the same digest.
		const held = newRun();
		const bad = fakeLane(daytona, {
			trial: () => ({ result: { agent_execution: { started_at: null } } }),
		});
		laneTick(held, bad.ops, { budgetUsd: 10_000 });
		const log = laneTick(held, bad.ops);
		expect(
			log.some((l) =>
				l.startsWith(
					"REVIEW r-b1-fp8-rmsnorm-gemm-a01: infra:agent never started",
				),
			),
		).toBe(true);
		expect(laneTick(held, bad.ops).at(-1)).toContain("review pending");
		expect(
			failureDigest(held.dir, replay(held.journal.events()))[0],
		).toMatchObject({ outcome: "infra", review: "pending" });
	});

	it("the CPU tick runs the lane and keeps lane tasks out of CPU scheduling", () => {
		const run = newRun();
		const { ops: laneOps, launched: laneLaunched } = fakeLane(daytona, {
			trial: () => "pending",
		});
		const cpuLaunched: string[] = [];
		const cpuOps: HostOps = {
			launch: (_h, id) => void cpuLaunched.push(id),
			observe: () => ({
				processAlive: true,
				hostReachable: true,
				hostRebootedSinceLaunch: false,
			}),
			collect: () => [],
			health: () => ({ ok: true, why: "" }),
		};
		writeBudget(run.dir, { budgetUsd: 1000 });
		tick({
			runDir: run.dir,
			journal: run.journal,
			hosts: [
				{
					name: "gpu-0",
					kind: "gpu",
					vcpu: 16,
					memoryMb: 262144,
					address: "y",
				},
			],
			tasks: gpuTasks,
			ops: cpuOps,
			review: noStage1,
			gpuLane: {
				ops: laneOps,
				lane: run.lane,
				config: cfg,
				budget: () => readBudget(run.dir, {}),
			},
		});
		expect(cpuLaunched).toEqual([]);
		expect(laneLaunched).toEqual(["r-b1-fp8-rmsnorm-gemm-a01"]);
	});
});

describe("tb4 GPU lane on an AWS Docker GPU host", () => {
	const p5: GpuTarget = { kind: "docker", host: "gpu-0", hourlyUsd: 5.97 };
	it("prices the worst case per host-hour, counts the host's uptime while paused, and asserts the H100", () => {
		const run = newRun();
		const { ops, launched } = fakeLane(p5, {
			trial: () => ({ result: { ...graded(1), gpuAsserted: true } }),
		});
		// The host has run for 2 h already ($11.94); fp8 worst on the host $79.60 + $5.
		const billing = gpuHostBilling(
			[
				{
					name: "gpu-0",
					kind: "gpu",
					vcpu: 16,
					memoryMb: 1,
					address: "",
					type: "p5.4xlarge",
					launchedAt: Date.parse("2026-10-28T22:00:00Z"),
				},
			],
			"2026-10-29T00:00:00Z",
			{},
		);
		expect(billing[0].usd).toBeCloseTo(11.94, 2);
		const t = (budgetUsd: number) => {
			writeBudget(run.dir, { budgetUsd });
			return gpuLaneTick({
				journal: run.journal,
				lane: run.lane,
				tasks: gpuTasks,
				ops,
				budget: readBudget(run.dir, {}),
				hostBilling: billing,
				config: cfg,
				review: noStage1,
				now: clock,
			});
		};
		const log = t(90);
		expect(launched).toEqual([]);
		expect(log.at(-1)).toContain("keeps billing $5.97/h while paused");
		expect(run.lane.events().find((e) => e.type === "gpu-pause")).toMatchObject(
			{ target: "gpu-lane:gpu-0", worstCaseUsd: 79.6, spentUsd: 11.94 },
		);
		t(100);
		expect(launched).toEqual(["r-b1-fp8-rmsnorm-gemm-a01"]);
		t(100);
		// The trial's host time is recorded for the report, not added to the uptime twice.
		const spend = run.lane.events().find((e) => e.type === "gpu-spend");
		expect(spend).toMatchObject({ basis: "host" });
		expect(spentEstimate(run.lane.events(), {}, billing)).toBeCloseTo(11.94, 2);
		// No H100 from nvidia-smi on the host: void (infra).
		expect(classifyGpuTrial(p5, graded(1), [])).toMatchObject({
			kind: "infra",
		});
		expect(
			classifyGpuTrial(p5, { ...graded(1), gpuAsserted: true }, []),
		).toMatchObject({ kind: "valid" });
	});

	it("waits while another trial unit runs on the GPU host", () => {
		const run = newRun();
		const { ops, launched } = fakeLane(p5, {
			trial: () => "pending",
			live: () => [
				{
					id: "tb4-trial-other.service",
					state: "active",
					gpus: 1,
					cpus: 0,
					memoryGiB: 0,
					storageGiB: 0,
					lane: false,
				},
			],
		});
		writeBudget(run.dir, { budgetUsd: 1000 });
		const log = gpuLaneTick({
			journal: run.journal,
			lane: run.lane,
			tasks: gpuTasks,
			ops,
			budget: readBudget(run.dir, {}),
			config: cfg,
			review: noStage1,
			now: clock,
		});
		expect(launched).toEqual([]);
		expect(log.at(-1)).toContain("holds the GPU");
	});
});

describe("tb4 Daytona Harbor patch (sitecustomize.py, offline)", () => {
	it("creates the verifier sandbox only after the agent sandbox is gone, asserts the H100, logs lifetimes", () => {
		const root = mkdtempSync(join(tmpdir(), "tb4patch-"));
		const pkg = join(root, "stub", "harbor", "environments", "daytona");
		mkdirSync(pkg, { recursive: true });
		for (const d of [
			"harbor",
			"harbor/environments",
			"harbor/environments/daytona",
		])
			writeFileSync(join(root, "stub", d, "__init__.py"), "");
		// A fake Harbor DaytonaEnvironment and a fake account: a deleted sandbox stays
		// listed ("destroying") for two polls, as Daytona's deletion is asynchronous.
		writeFileSync(
			join(pkg, "environment.py"),
			`
import itertools
EVENTS = []
class Exec:
    def __init__(self, r): self.result = r
class Proc:
    def __init__(self, gpu): self.gpu = gpu
    async def exec(self, cmd, timeout=None): return Exec(self.gpu)
class SB:
    _ids = itertools.count(1)
    def __init__(self, acct, gpu_name):
        self.id = f"sb{next(SB._ids)}"; self.acct = acct; self.state = "started"
        self.cpu, self.memory, self.disk, self.gpu = 4, 16, 30, 1
        self.process = Proc(gpu_name); self.polls = 0
    async def refresh_data(self): pass
    async def delete(self): self.state = "destroying"; EVENTS.append(("delete", self.id))
class Account:
    def __init__(self): self.sbs = []
    async def list(self):
        out = []
        for s in self.sbs:
            if s.state == "destroying":
                s.polls += 1
                if s.polls > 2: s.state = "destroyed"
            out.append(s)
        return out
    async def get(self, i):
        for s in await self.list():
            if s.id == i: return s
        raise KeyError(i)
ACCOUNT = Account()
class TaskEnv:
    def __init__(self, image): self.docker_image = image
class Mgr:
    async def get_client(self): return ACCOUNT
class DaytonaEnvironment:
    def __init__(self, image, session, gpu_name="NVIDIA H100 80GB HBM3"):
        self.task_env_config = TaskEnv(image); self.session_id = session
        self._effective_gpus = 1; self._client_manager = Mgr(); self._sandbox = None
        self.environment_dir = "/nonexistent"; self.gpu_name = gpu_name
    def _sandbox_common_kwargs(self): return {}
    def _resolve_user(self, user): return user
    async def _resolve_start_sandbox_params(self, daytona, resources, *, force_build): return None
    def _sandbox_labels(self): return {"harbor.managed": "true"}
    async def _create_sandbox(self, params, daytona=None):
        live = [s for s in ACCOUNT.sbs if s.state not in ("destroyed",)]
        if live: raise RuntimeError("Total GPU limit exceeded")
        s = SB(ACCOUNT, self.gpu_name); ACCOUNT.sbs.append(s); self._sandbox = s
        EVENTS.append(("create", s.id, self.session_id))
    async def _stop_sandbox(self):
        await self._sandbox.delete()
`,
		);
		const log = join(root, "sandboxes.jsonl");
		const out = execFileSync(
			"python3",
			[
				"-I",
				"-c",
				`
import sys, asyncio, json, importlib.util
sys.path.insert(0, sys.argv[1])
# Load the patch by path: the interpreter may already have imported its own sitecustomize.
spec = importlib.util.spec_from_file_location("ytimesy_patch", sys.argv[2] + "/sitecustomize.py")
spec.loader.exec_module(importlib.util.module_from_spec(spec))
from harbor.environments.daytona import environment as E
async def main():
    agent = E.DaytonaEnvironment("img-environment-x", "trial__x")
    await agent._create_sandbox(None)
    await agent._stop_sandbox()   # Harbor stops the agent env before the verifier starts
    verifier = E.DaytonaEnvironment("img-verifier-y", "trial__verifier__main")
    await verifier._create_sandbox(None)
    labels = verifier._sandbox_labels()
    await verifier._stop_sandbox()
    bad = E.DaytonaEnvironment("img-environment-z", "trial2", gpu_name="NVIDIA A100")
    try:
        await bad._create_sandbox(None); print("NO-RAISE")
    except RuntimeError as e:
        print("RAISED", str(e)[:60])
    print(json.dumps({"events": E.EVENTS, "labels": labels}))
asyncio.run(main())
`,
				join(root, "stub"),
				join(HERE, "..", "scripts", "tb4-run", "host", "daytona"),
			],
			{
				encoding: "utf8",
				env: {
					PATH: process.env.PATH,
					YTIMESY_DAYTONA_SANDBOX_LOG: log,
					YTIMESY_DAYTONA_POLL_SEC: "0.01",
					YTIMESY_ATTEMPT_ID: "r-b1-fp8-rmsnorm-gemm-a01",
				},
			},
		);
		expect(out).toContain("RAISED ytimesy GPU assertion");
		const { events, labels } = JSON.parse(out.trim().split("\n").at(-1)!);
		// Without the guard the verifier's create would have hit "Total GPU limit exceeded".
		expect(events.map((e: string[]) => e[0])).toEqual([
			"create",
			"delete",
			"create",
			"delete",
			"create",
		]);
		expect(labels).toMatchObject({
			"ytimesy-lane": "tb4-gpu",
			"ytimesy-attempt": "r-b1-fp8-rmsnorm-gemm-a01",
		});
		expect(existsSync(log)).toBe(true);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		const kinds = lines.map(
			(l) => `${JSON.parse(l).event}:${JSON.parse(l).role ?? ""}`,
		);
		expect(kinds.slice(0, 8)).toEqual([
			"create:agent",
			"gpu-assert:agent",
			"delete:agent",
			"gone:agent",
			"create:verifier",
			"gpu-assert:verifier",
			"delete:verifier",
			"gone:verifier",
		]);
		// The lane reads that log: valid trial, sandboxes billed.
		expect(classifyGpuTrial(daytona, graded(1), lines)).toMatchObject({
			kind: "valid",
		});
	});
});
