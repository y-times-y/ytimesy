import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	failureDigest,
	findTaskTomls,
	type HostOps,
	loadTasks,
	readProbe,
	readTrialDir,
	tick,
} from "../scripts/tb4-run/controller.ts";
import {
	contextWindowFromLog,
	egressAllowed,
	egressPreflightVerdict,
	startEgressGuard,
	startFaultProxy,
} from "../scripts/tb4-run/faults/fault-proxy.ts";
import {
	batch2Decision,
	bridgeLogEvidence,
	classify,
	earlyStopDecision,
	earlyStopGates,
	errorSpike,
	failureCause,
	fitsCpu,
	floorCeiling,
	HOST_RESERVED_VCPU,
	type Host,
	type HostObservation,
	hostCpuBudget,
	Journal,
	type JournalEvent,
	lastModelCallFailed,
	ledgerTotals,
	needsReview,
	nextLaunches,
	pairedComparison,
	passAtK,
	replay,
	reviewConfig,
	SPEND,
	sanitizeLine,
	scoredTrials,
	stage1Complete,
	type Task,
	TRIAL_OVERHEAD_VCPU,
	taskFromToml,
	watch,
} from "../scripts/tb4-run/lib.ts";
import { bedrockErrors, sendAlerts } from "../scripts/tb4-run/watchdog.ts";

const tasks: Task[] = [
	{ name: "cpu-a", cpus: 4, memoryMb: 8192, gpus: 0, separateVerifier: false },
	{ name: "cpu-b", cpus: 4, memoryMb: 8192, gpus: 0, separateVerifier: false },
	{ name: "gpu-a", cpus: 8, memoryMb: 65536, gpus: 1, separateVerifier: false },
];
const hosts: Host[] = [
	{ name: "cpu-0", kind: "cpu", vcpu: 64, memoryMb: 262144, address: "x" },
	{ name: "gpu-0", kind: "gpu", vcpu: 16, memoryMb: 262144, address: "y" },
];
const started = (r: number, at = "2026-10-22T00:00:00Z") => ({
	agent_execution: { started_at: at },
	verifier_result: { rewards: { reward: r } },
});

/** A fake fleet: each launched attempt finishes on the next tick unless told otherwise. */
function fakeOps(
	script: (id: string) => Partial<HostObservation> | "pending" = () => ({
		result: started(1),
	}),
) {
	const launched: string[] = [];
	const ops: HostOps = {
		launch: (_h, id) => void launched.push(id),
		observe: (_h, id) => {
			const s = script(id);
			if (s === "pending")
				return {
					processAlive: true,
					hostReachable: true,
					hostRebootedSinceLaunch: false,
				};
			return {
				processAlive: false,
				hostReachable: true,
				hostRebootedSinceLaunch: false,
				...s,
			};
		},
		collect: () => ["controller:x"],
		health: () => ({ ok: true, why: "" }),
	};
	return { ops, launched };
}
/** Rerun mechanics without the review gate (tested on its own below). */
const noGate = reviewConfig({ TB4_REVIEW_GATE: "off" });
function newRun() {
	const dir = mkdtempSync(join(tmpdir(), "tb4run-"));
	const journal = new Journal(join(dir, "journal.jsonl"));
	journal.append({
		at: "t",
		type: "run-start",
		runId: "r1",
		commit: "abc",
		bundleSha256: "0".repeat(64),
	});
	journal.append({ at: "t", type: "batch-open", batch: "b1" });
	return { dir, journal };
}

describe("tb4 controller", () => {
	it("launches one batch-1 trial per task, GPU on the GPU host, and finishes them", () => {
		const { dir, journal } = newRun();
		const { ops, launched } = fakeOps();
		tick({ runDir: dir, journal, hosts, tasks, ops });
		expect(launched.sort()).toEqual([
			"r1-b1-cpu-a-a01",
			"r1-b1-cpu-b-a01",
			"r1-b1-gpu-a-a01",
		]);
		expect(replay(journal.events()).attempts.get("r1-b1-gpu-a-a01")?.host).toBe(
			"gpu-0",
		);
		tick({ runDir: dir, journal, hosts, tasks, ops });
		const s = replay(journal.events());
		expect(
			[...s.attempts.values()].every((a) => a.outcome?.kind === "valid"),
		).toBe(true);
		expect(launched).toHaveLength(3); // nothing more to run in batch 1
	});

	it("resumes after a restart without duplicating a running trial", () => {
		const { dir, journal } = newRun();
		const { ops, launched } = fakeOps(() => "pending");
		tick({ runDir: dir, journal, hosts, tasks, ops });
		// Controller restarts: a fresh tick replays the journal and adopts the running trials.
		tick({ runDir: dir, journal, hosts, tasks, ops });
		tick({ runDir: dir, journal, hosts, tasks, ops });
		expect(launched).toHaveLength(3);
	});

	it("journal written before launch: a trial that never reached the host is infra and rerun", () => {
		const { dir, journal } = newRun();
		journal.append({
			at: "t",
			type: "launch",
			attemptId: "r1-b1-cpu-a-a01",
			task: "cpu-a",
			batch: "b1",
			host: "cpu-0",
		});
		const { ops, launched } = fakeOps(() => ({}));
		tick({ runDir: dir, journal, hosts, tasks, ops, review: noGate });
		const s = replay(journal.events());
		expect(s.attempts.get("r1-b1-cpu-a-a01")?.outcome).toMatchObject({
			kind: "infra",
		});
		expect(launched).toContain("r1-b1-cpu-a-a02");
	});

	it("host restart mid-trial: infra, rerun; a graded trial is never rerun", () => {
		const { dir, journal } = newRun();
		const { ops, launched } = fakeOps((id) =>
			id.includes("cpu-a-a01")
				? { hostRebootedSinceLaunch: true }
				: { result: started(0) },
		);
		tick({ runDir: dir, journal, hosts, tasks, ops, review: noGate });
		tick({ runDir: dir, journal, hosts, tasks, ops, review: noGate });
		expect(launched.filter((l) => l.includes("cpu-a"))).toEqual([
			"r1-b1-cpu-a-a01",
			"r1-b1-cpu-a-a02",
		]);
		expect(launched.filter((l) => l.includes("cpu-b"))).toEqual([
			"r1-b1-cpu-b-a01",
		]); // graded 0: kept
	});

	it("stops at the attempt cap", () => {
		const { dir, journal } = newRun();
		const { ops, launched } = fakeOps(() => ({
			result: { agent_execution: { started_at: null } },
		}));
		for (let i = 0; i < 10; i++)
			tick({
				runDir: dir,
				journal,
				hosts,
				tasks: [tasks[0]],
				ops,
				review: noGate,
			});
		expect(launched).toHaveLength(4); // 1 trial + 3 infra reruns
	});

	it("unreachable host: waits, launches nothing new there", () => {
		const { dir, journal } = newRun();
		const { ops, launched } = fakeOps(() => ({ hostReachable: false }));
		ops.health = () => ({ ok: false, why: "ssh" });
		tick({ runDir: dir, journal, hosts, tasks, ops });
		expect(launched).toHaveLength(0);
	});

	it("pause and stop block launches", () => {
		const { journal } = newRun();
		journal.append({ at: "t", type: "pause", reason: "bedrock-throttle" });
		expect(
			nextLaunches({ state: replay(journal.events()), tasks, hosts }),
		).toEqual([]);
	});

	it("reads a Harbor job dir with transport and manifest evidence", () => {
		const dir = mkdtempSync(join(tmpdir(), "tb4job-"));
		mkdirSync(join(dir, "t__x", "artifacts"), { recursive: true });
		writeFileSync(join(dir, "t__x", "result.json"), JSON.stringify(started(1)));
		writeFileSync(
			join(dir, "t__x", "artifacts", "manifest.json"),
			JSON.stringify([{ source: "/app", status: "failed" }]),
		);
		expect(classify(readTrialDir(dir)!)).toMatchObject({
			kind: "infra",
			reason: "agent /app did not reach the grader",
		});
	});
});

describe("tb4 host CPU budget", () => {
	const host: Host = {
		name: "cpu-0",
		kind: "cpu",
		vcpu: 64,
		memoryMb: 1 << 30,
		address: "x",
	};
	const two = (i: number): Task => ({
		name: `t${i}`,
		cpus: 2,
		memoryMb: 1024,
		gpus: 0,
		separateVerifier: true,
	});

	it("keeps the sum of in-flight task cpus plus overhead within vCPU minus the reserve", () => {
		const many = Array.from({ length: 40 }, (_, i) => two(i));
		const { journal } = newRun();
		const launches = nextLaunches({
			state: replay(journal.events()),
			tasks: many,
			hosts: [host],
		});
		// 2 cpus + 1 overhead per trial in 64 - 2 = 62: 20 trials, not 32.
		expect(launches).toHaveLength(
			Math.floor(hostCpuBudget(host) / (2 + TRIAL_OVERHEAD_VCPU)),
		);
		expect(launches.length * (2 + TRIAL_OVERHEAD_VCPU)).toBeLessThanOrEqual(
			host.vcpu - HOST_RESERVED_VCPU,
		);
	});

	it("launches every open batch's trials of front-loaded tasks before anything else", () => {
		const many = Array.from({ length: 6 }, (_, i) => two(i));
		const { journal } = newRun();
		journal.append({ at: "t", type: "batch-open", batch: "b2" });
		const launches = nextLaunches({
			state: replay(journal.events()),
			tasks: many,
			hosts: [host],
			maxInFlight: 5,
			frontload: ["t3"],
		});
		expect(launches.map((l) => `${l.task}/${l.batch}`)).toEqual([
			"t3/b1",
			"t3/b2",
			"t3/b2",
			"t3/b2",
			"t3/b2",
		]);
	});

	it("launches priority tasks first", () => {
		const many = Array.from({ length: 6 }, (_, i) => two(i));
		const { journal } = newRun();
		const launches = nextLaunches({
			state: replay(journal.events()),
			tasks: many,
			hosts: [host],
			maxInFlight: 2,
			priority: ["t4", "t2"],
		});
		expect(launches.map((l) => l.task)).toEqual(["t4", "t2"]);
	});

	it("never launches past the fleet-wide in-flight cap", () => {
		const many = Array.from({ length: 40 }, (_, i) => two(i));
		const { journal } = newRun();
		for (let i = 0; i < 5; i++)
			journal.append({
				at: "t",
				type: "launch",
				attemptId: `r1-b1-x${i}-a01`,
				task: `t${i}`,
				batch: "b1",
				host: "cpu-0",
			});
		const launches = nextLaunches({
			state: replay(journal.events()),
			tasks: many,
			hosts: [host],
			maxInFlight: 12,
		});
		expect(launches).toHaveLength(7);
	});

	it("counts running trials from the journal", () => {
		const { journal } = newRun();
		for (let i = 0; i < 19; i++)
			journal.append({
				at: "t",
				type: "launch",
				attemptId: `r1-b1-t${i}-a01`,
				task: `t${i}`,
				batch: "b1",
				host: "cpu-0",
			});
		const many = Array.from({ length: 40 }, (_, i) => two(i));
		expect(
			nextLaunches({
				state: replay(journal.events()),
				tasks: many,
				hosts: [host],
			}),
		).toHaveLength(1);
	});

	it("an idle host takes one task as large as itself, and only that one", () => {
		const p5: Host = {
			name: "gpu-0",
			kind: "gpu",
			vcpu: 16,
			memoryMb: 262144,
			address: "y",
		};
		const jax: Task = {
			name: "jax",
			cpus: 16,
			memoryMb: 32768,
			gpus: 1,
			separateVerifier: true,
		};
		expect(fitsCpu(p5, { vcpu: 0, trials: 0 }, jax)).toBe(true);
		expect(fitsCpu(p5, { vcpu: 5, trials: 1 }, { cpus: 2 })).toBe(true);
		expect(fitsCpu(p5, { vcpu: 5, trials: 1 }, { cpus: 16 })).toBe(false);
		const { journal } = newRun();
		expect(
			nextLaunches({
				state: replay(journal.events()),
				tasks: [jax],
				hosts: [p5],
			}),
		).toHaveLength(1);
	});

	it("reads cpus as max(environment, separate verifier) from task.toml in Harbor's cache layout", () => {
		expect(
			taskFromToml("x", {
				environment: { cpus: 4, memory_mb: 8192, gpus: 0 },
				verifier: {
					environment_mode: "separate",
					environment: { cpus: 6, memory_mb: 4096 },
				},
			}),
		).toEqual({
			name: "x",
			cpus: 6,
			memoryMb: 8192,
			gpus: 0,
			separateVerifier: true,
		});
		const root = mkdtempSync(join(tmpdir(), "tb4cache-"));
		mkdirSync(join(root, "vpp", "abc123"), { recursive: true });
		writeFileSync(
			join(root, "vpp", "abc123", "task.toml"),
			'[verifier]\nenvironment_mode = "separate"\n[verifier.environment]\ncpus = 2\nmemory_mb = 8192\n[environment]\ncpus = 2\nmemory_mb = 8192\ngpus = 0\n',
		);
		expect([...findTaskTomls(root).keys()]).toEqual(["vpp"]);
		expect(loadTasks(root)).toEqual([
			{ name: "vpp", cpus: 2, memoryMb: 8192, gpus: 0, separateVerifier: true },
		]);
	});
});

describe("tb4 scoring", () => {
	it("classifies per the rule", () => {
		expect(classify(started(0))).toMatchObject({ kind: "valid", reward: 0 });
		expect(
			classify({
				agent_execution: { started_at: "x" },
				verifier_result: { rewards: { reward: null } },
			}),
		).toMatchObject({ kind: "infra" });
		expect(classify({ ...started(1), gpuAsserted: false })).toMatchObject({
			kind: "infra",
		});
		expect(
			classify({
				...started(1),
				harnessStoppedOnModelFailure: true,
				unrecoveredTransportFailure: "{}",
			}),
		).toMatchObject({ kind: "infra" });
		expect(
			classify({
				...started(0),
				harnessStoppedOnModelFailure: true,
				unrecoveredTransportFailure: null,
			}),
		).toMatchObject({ kind: "valid" });
	});

	it("first trials by agent start per batch; extras disclosed", () => {
		const { journal } = newRun();
		journal.append({ at: "t", type: "batch-open", batch: "b2" });
		const add = (id: string, batch: "b1" | "b2", at: string, r: number) => {
			journal.append({
				at,
				type: "launch",
				attemptId: id,
				task: "cpu-a",
				batch,
				host: "cpu-0",
			});
			journal.append({
				at,
				type: "finish",
				attemptId: id,
				outcome: { kind: "valid", reward: r, agentStartedAt: at, detail: "" },
			});
		};
		add("b1x", "b1", "2026-10-22T01:00:00Z", 1);
		add("b1y", "b1", "2026-10-22T02:00:00Z", 0);
		for (let i = 0; i < 5; i++)
			add(`b2-${i}`, "b2", `2026-10-23T0${i}:00:00Z`, i % 2);
		const s = scoredTrials(replay(journal.events())).get("cpu-a")!;
		expect(s.scored.map((t) => t.attemptId)).toEqual([
			"b1x",
			"b2-0",
			"b2-1",
			"b2-2",
			"b2-3",
		]);
		expect(s.extra.map((t) => t.attemptId)).toEqual(["b1y", "b2-4"]);
	});

	it("pass@k, paired comparison and the batch-2 rule", () => {
		expect(passAtK(5, 0, 1)).toBe(0);
		expect(passAtK(5, 2, 1)).toBeCloseTo(0.4);
		expect(passAtK(5, 1, 5)).toBe(1);
		const cmp = pairedComparison([1, 1, 0, 0.6], [0.8, 1, 0.2, 0.6]);
		expect(cmp.meanDiffPts).toBeCloseTo(0);
		expect(cmp.tasksBetter).toBe(1);
		expect(batch2Decision(cmp).go).toBe(false);
		expect(batch2Decision(pairedComparison([1, 1], [0.9, 0.9])).go).toBe(true);
	});
});

describe("tb4 watchdog and spend", () => {
	const base = {
		now: 10 * 3_600_000,
		state: replay([]),
		logSilenceMs: new Map<string, number>(),
		unhealthyHosts: [] as string[],
		bedrockErrorsLast15m: { throttles: 0, serverErrors: 0 },
		modelSpendUsd: 0,
		infraSpendUsd: 0,
		alerted: { model: [] as number[], infra: [] as number[] },
		controllerActive: true,
		lastProgressAt: 10 * 3_600_000,
	};
	it("alerts on silence, hosts, throttles, spend thresholds and a dead controller", () => {
		const r = watch({
			...base,
			logSilenceMs: new Map([["a1", 21 * 60_000]]),
			unhealthyHosts: ["cpu-1"],
			bedrockErrorsLast15m: { throttles: 25, serverErrors: 0 },
			modelSpendUsd: 760,
			alerted: { model: [0.5], infra: [] },
			controllerActive: false,
		});
		expect(r.alerts.map((a) => a.key).sort()).toEqual([
			"bedrock-throttle",
			"controller-down",
			"host:cpu-1",
			"model-spend-0.8",
			"silent:a1",
		]);
		expect(r.actions).toEqual(["restart-controller", "pause:bedrock-throttle"]);
		expect(
			watch({
				...base,
				modelSpendUsd: 900,
				alerted: { model: [0.5, 0.8], infra: [] },
			}).actions,
		).toEqual(["stop:model-cap"]);
	});
	it("ledger totals and Bedrock error counting", () => {
		expect(
			ledgerTotals([
				{ type: "reserve", trial: "a", usd: 12 },
				{ type: "settle", trial: "a", usd: 1.5 },
				{ type: "reserve", trial: "b", usd: 12 },
			]),
		).toEqual({ settled: 1.5, reserved: 12 });
		const now = Date.parse("2026-10-22T00:20:00Z");
		const lines = [
			JSON.stringify({ at: "2026-10-22T00:10:00Z", status: 429 }),
			JSON.stringify({
				at: "2026-10-22T00:11:00Z",
				code: "ThrottlingException",
			}),
			JSON.stringify({ at: "2026-10-22T00:12:00Z", status: 503 }),
			JSON.stringify({ at: "2026-10-21T00:12:00Z", status: 429 }),
		];
		expect(bedrockErrors(lines, now - 15 * 60_000)).toEqual({
			throttles: 2,
			serverErrors: 1,
		});
	});
	it("holds repeat alerts for an hour", async () => {
		const ws = {
			alerted: { model: [], infra: [] },
			lastSent: {},
			lastProgressAt: 0,
			lastFinished: 0,
		};
		const posts: string[] = [];
		const post = (async (_u: unknown, init: { body: string }) =>
			void posts.push(init.body)) as unknown as typeof fetch;
		const alert = [{ level: "warn" as const, key: "k", text: "t" }];
		await sendAlerts(alert, ws, 1000, "https://ntfy.sh/x", post);
		await sendAlerts(alert, ws, 2000, "https://ntfy.sh/x", post);
		await sendAlerts(alert, ws, 1000 + 61 * 60_000, "https://ntfy.sh/x", post);
		expect(posts).toHaveLength(2);
	});
});

describe("tb4 fault proxy (offline)", () => {
	async function upstream() {
		const server = createServer((req, res) => {
			if (req.url === "/sse") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write('event: response.output_text.delta\ndata: {"d":"a"}\n\n');
				res.write('event: response.output_text.delta\ndata: {"d":"b"}\n\n');
				res.end("event: response.completed\ndata: {}\n\n");
			} else res.end("ok");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const a = server.address();
		return {
			server,
			url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`,
		};
	}
	it("cut: forwards events but never the terminal one", async () => {
		const up = await upstream();
		const p = await startFaultProxy({ upstream: up.url, fault: "cut", nth: 1 });
		const text = await (await fetch(`http://127.0.0.1:${p.port}/sse`)).text();
		expect(text).toContain('"d":"b"');
		expect(text).not.toContain("response.completed");
		const second = await (await fetch(`http://127.0.0.1:${p.port}/sse`)).text();
		expect(second).toContain("response.completed");
		expect(p.injected()).toBe(1);
		p.server.close();
		up.server.close();
	});
	it("throttle, reset and outage", async () => {
		const up = await upstream();
		const t = await startFaultProxy({
			upstream: up.url,
			fault: "throttle",
			nth: 1,
		});
		const r = await fetch(`http://127.0.0.1:${t.port}/x`);
		expect(r.status).toBe(429);
		expect(r.headers.get("x-amzn-errortype")).toBe("ThrottlingException");
		const o = await startFaultProxy({
			upstream: up.url,
			fault: "outage",
			nth: 1,
			outageSec: 60,
		});
		await expect(fetch(`http://127.0.0.1:${o.port}/x`)).rejects.toThrow();
		await expect(fetch(`http://127.0.0.1:${o.port}/x`)).rejects.toThrow();
		const s = await startFaultProxy({
			upstream: up.url,
			fault: "reset",
			nth: 1,
		});
		await expect(
			fetch(`http://127.0.0.1:${s.port}/sse`).then((x) => x.text()),
		).rejects.toThrow();
		for (const x of [t, o, s]) x.server.close();
		up.server.close();
	});
});

describe("tb4 Astra x5 run rules", () => {
	const trial = (reward: number, i: number) => ({
		attemptId: `a${i}`,
		batch: "b1" as const,
		reward,
		agentStartedAt: `t${i}`,
	});
	it("floor counts missing trials as fails, ceiling as passes", () => {
		const perTask = new Map([
			["x", { scored: [trial(1, 1), trial(1, 2), trial(0, 3)] }],
			[
				"y",
				{
					scored: [
						trial(1, 4),
						trial(1, 5),
						trial(1, 6),
						trial(1, 7),
						trial(1, 8),
					],
				},
			],
		]);
		const b = floorCeiling(perTask, ["x", "y", "z"], 5);
		expect(b.missingTrials).toBe(2 + 0 + 5);
		expect(b.floorPct).toBeCloseTo((100 * (2 / 5 + 1 + 0)) / 3);
		expect(b.ceilingPct).toBeCloseTo((100 * (4 / 5 + 1 + 1)) / 3);
	});
	it("stops early only when the ceiling is below the competitor", () => {
		expect(
			earlyStopDecision(
				{ floorPct: 40, ceilingPct: 55, missingTrials: 9 },
				57.9,
			).stop,
		).toBe(true);
		expect(
			earlyStopDecision(
				{ floorPct: 60, ceilingPct: 70, missingTrials: 9 },
				57.9,
			),
		).toMatchObject({ stop: false });
		expect(
			earlyStopDecision(
				{ floorPct: 60, ceilingPct: 70, missingTrials: 9 },
				57.9,
			).why,
		).toContain("ahead");
		expect(
			earlyStopDecision(
				{ floorPct: 50, ceilingPct: 65, missingTrials: 9 },
				57.9,
			).why,
		).toContain("undecided");
	});
	it("open-all journals both batches at init", () => {
		const dir = mkdtempSync(join(tmpdir(), "tb4astra-"));
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
		expect([...replay(journal.events()).openBatches].sort()).toEqual([
			"b1",
			"b2",
		]);
	});
	it("stops launches at the cap minus the margin for running trials", () => {
		const saved = {
			cap: SPEND.modelTotalCapUsd,
			margin: SPEND.modelStopMarginUsd,
		};
		Object.assign(SPEND, { modelTotalCapUsd: 2400, modelStopMarginUsd: 300 });
		try {
			const input = {
				now: 0,
				state: replay([]),
				logSilenceMs: new Map<string, number>(),
				unhealthyHosts: [] as string[],
				bedrockErrorsLast15m: { throttles: 0, serverErrors: 0 },
				infraSpendUsd: 0,
				alerted: { model: [0.5, 0.8], infra: [] as number[] },
				controllerActive: true,
				lastProgressAt: 0,
			};
			expect(watch({ ...input, modelSpendUsd: 2050 }).actions).toEqual([]);
			expect(watch({ ...input, modelSpendUsd: 2150 }).actions).toEqual([
				"stop:model-cap",
			]);
		} finally {
			Object.assign(SPEND, {
				modelTotalCapUsd: saved.cap,
				modelStopMarginUsd: saved.margin,
			});
		}
	});
	it("ships a trial cap for every TB4 task, at most the bridge maximum", async () => {
		const { readFileSync } = await import("node:fs");
		const caps = JSON.parse(
			readFileSync("scripts/tb4-run/astra-trial-caps.json", "utf8"),
		) as Record<string, number>;
		const codex = JSON.parse(
			readFileSync("benchmarks/evaluation/codex-astra-public-job.json", "utf8"),
		) as { tasks: Record<string, unknown> };
		expect(Object.keys(caps).sort()).toEqual(Object.keys(codex.tasks).sort());
		expect(Math.max(...Object.values(caps))).toBeLessThanOrEqual(100);
	});
	it("launches the largest GPU task first", () => {
		const gpuTasks: Task[] = [
			{
				name: "fp8",
				cpus: 4,
				memoryMb: 16384,
				gpus: 1,
				separateVerifier: true,
			},
			{
				name: "jax",
				cpus: 16,
				memoryMb: 32768,
				gpus: 1,
				separateVerifier: true,
			},
			{
				name: "math",
				cpus: 8,
				memoryMb: 16384,
				gpus: 1,
				separateVerifier: true,
			},
		];
		const { dir, journal } = newRun();
		const gpuHost: Host = {
			name: "gpu-0",
			kind: "gpu",
			vcpu: 16,
			memoryMb: 262144,
			address: "y",
		};
		const { ops, launched } = fakeOps(() => "pending");
		tick({
			runDir: dir,
			journal,
			hosts: [gpuHost],
			tasks: gpuTasks,
			ops,
			now: () => "t",
		});
		expect(launched.length).toBe(1);
		expect(launched[0]).toContain("jax");
	});
});

describe("last model call", () => {
	const line = (e: Record<string, unknown>) => JSON.stringify(e);
	it("flags a run whose last model call failed, not one that recovered", () => {
		const ok = line({
			phase: "stream",
			status: 200,
			terminal: "response.completed",
		});
		const throttled = line({ phase: "throttle", status: 429, willRetry: true });
		const gaveUp = line({ phase: "throttle", status: 429, willRetry: false });
		expect(lastModelCallFailed([ok, throttled, ok].join("\n"))).toBeNull();
		expect(lastModelCallFailed([ok, throttled, gaveUp].join("\n"))).toContain(
			'"status":429',
		);
		expect(
			lastModelCallFailed(
				[ok, line({ phase: "response", status: 500 })].join("\n"),
			),
		).toContain("500");
		expect(
			lastModelCallFailed(
				[line({ phase: "stream-cut", willRetry: true }), ok].join("\n"),
			),
		).toBeNull();
		expect(lastModelCallFailed("")).toBeNull();
	});
	it("scores a provider-ended run as infra", () => {
		expect(
			classify({
				agent_execution: { started_at: "x" },
				verifier_result: { rewards: { reward: 0 } },
				harnessStoppedOnModelFailure: true,
				unrecoveredTransportFailure: '{"phase":"throttle","status":429}',
			}),
		).toMatchObject({ kind: "infra" });
	});
});

describe("tb4 Astra early-stop gates", () => {
	const decisive = Array.from({ length: 16 }, (_, i) => `d${i}`);
	const cpuTasks = [
		...decisive,
		...Array.from({ length: 47 }, (_, i) => `o${i}`),
	];
	const codexRates = new Map(cpuTasks.map((t, i) => [t, i < 16 ? 0.4 : 0.6]));
	/** Journal events: one finished attempt per (task, reward | "infra"), started in order. */
	function events(
		rows: [string, number | "infra"][],
		extra: JournalEvent[] = [],
	): JournalEvent[] {
		const ev: JournalEvent[] = [
			{
				at: "t",
				type: "run-start",
				runId: "r",
				commit: "c",
				bundleSha256: "0".repeat(64),
			},
			{ at: "t", type: "batch-open", batch: "b1" },
			{ at: "t", type: "batch-open", batch: "b2" },
		];
		const seen = new Map<string, number>();
		rows.forEach(([task, r], i) => {
			const id = `${task}-${i}`;
			const n = seen.get(task) ?? 0;
			if (r !== "infra") seen.set(task, n + 1);
			ev.push({
				at: `t${i}`,
				type: "launch",
				attemptId: id,
				task,
				batch: n === 0 ? "b1" : "b2",
				host: "h",
			});
			ev.push({
				at: `t${i}`,
				type: "finish",
				attemptId: id,
				outcome:
					r === "infra"
						? { kind: "infra", reason: "host died" }
						: {
								kind: "valid",
								reward: r,
								agentStartedAt: `2026-10-28T00:${String(i).padStart(2, "0")}:00Z`,
								detail: "",
							},
			});
		});
		return [...ev, ...extra];
	}
	const gates = (ev: JournalEvent[]) =>
		earlyStopGates({ state: replay(ev), decisive, cpuTasks, codexRates });
	it("gate A waits for 15 of 16 decisive first trials", () => {
		const g = gates(
			events(decisive.slice(0, 14).map((t) => [t, 0] as [string, number])),
		);
		expect(g.gateA).toMatchObject({ status: "pending", ready: 14 });
	});
	it("gate A stops at <= 5 passes and passes at >= 6", () => {
		const five = decisive
			.slice(0, 15)
			.map((t, i) => [t, i < 5 ? 1 : 0] as [string, number]);
		expect(gates(events(five)).gateA).toMatchObject({
			status: "stop",
			passes: 5,
			ready: 15,
		});
		const six = decisive
			.slice(0, 15)
			.map((t, i) => [t, i < 6 ? 1 : 0] as [string, number]);
		expect(gates(events(six)).gateA).toMatchObject({
			status: "pass",
			passes: 6,
		});
		expect(
			gates(
				events(five, [
					{
						at: "t",
						type: "gate",
						gate: "A",
						result: "pass",
						detail: "earlier",
					},
				]),
			).gateA.status,
		).toBe("passed");
	});
	it("gate A ignores infra attempts and uses the first valid trial by agent start", () => {
		const rows: [string, number | "infra"][] = decisive
			.slice(0, 15)
			.map((t) => [t, "infra"]);
		expect(gates(events(rows)).gateA).toMatchObject({
			status: "pending",
			ready: 0,
		});
		const mixed: [string, number | "infra"][] = [
			...decisive.slice(0, 15).map((t) => [t, "infra"] as [string, "infra"]),
			...decisive.slice(0, 15).map((t) => [t, 1] as [string, number]),
			...decisive.slice(0, 15).map((t) => [t, 0] as [string, number]),
		];
		expect(gates(events(mixed)).gateA).toMatchObject({
			status: "pass",
			passes: 15,
			ready: 15,
		});
	});
	it("gate B stops when the CPU-task ceiling falls below Codex on the same tasks", () => {
		// Codex here: (16 x 0.4 + 47 x 0.6) / 63 = 54.9%. Fail every trial of 29 tasks -> ceiling 54.0%.
		const failed = cpuTasks
			.slice(0, 29)
			.flatMap((t) =>
				Array.from({ length: 5 }, () => [t, 0] as [string, number]),
			);
		const g = gates(events(failed));
		expect(g.gateB.codexPct).toBeCloseTo((100 * (16 * 0.4 + 47 * 0.6)) / 63);
		expect(g.gateB.ceilingPct).toBeCloseTo((100 * 34) / 63);
		expect(g.gateB.stop).toBe(true);
		const g2 = gates(
			events(
				cpuTasks
					.slice(0, 28)
					.flatMap((t) =>
						Array.from({ length: 5 }, () => [t, 0] as [string, number]),
					),
			),
		);
		expect(g2.gateB.stop).toBe(false);
	});
	it("a stop in the tick journals the gate and blocks new launches", () => {
		const { dir, journal } = newRun();
		journal.append({ at: "t", type: "batch-open", batch: "b2" });
		const ts: Task[] = decisive.map((name) => ({
			name,
			cpus: 2,
			memoryMb: 4096,
			gpus: 0,
			separateVerifier: false,
		}));
		for (const [i, t] of ts.slice(0, 15).entries()) {
			const id = `${t.name}-x`;
			journal.append({
				at: "t",
				type: "launch",
				attemptId: id,
				task: t.name,
				batch: "b1",
				host: "cpu-0",
			});
			journal.append({
				at: "t",
				type: "finish",
				attemptId: id,
				outcome: {
					kind: "valid",
					reward: i < 3 ? 1 : 0,
					agentStartedAt: `2026-10-28T00:${String(i).padStart(2, "0")}:00Z`,
					detail: "",
				},
			});
		}
		const saved = { ...process.env };
		Object.assign(process.env, {
			TB4_EARLY_STOP: "on",
			TB4_PRIORITY_TASKS: decisive.join(","),
		});
		const codexPath = join(dir, "codex.json");
		writeFileSync(
			codexPath,
			JSON.stringify({
				tasks: Object.fromEntries(
					decisive.map((t) => [t, { passes: 2, trials: 5 }]),
				),
			}),
		);
		process.env.TB4_CODEX_JOB = codexPath;
		try {
			const { ops, launched } = fakeOps(() => "pending");
			const log = tick({
				runDir: dir,
				journal,
				hosts: [hosts[0]],
				tasks: ts,
				ops,
				now: () => "t",
			});
			expect(
				log.some((l) => l.startsWith("gates: A stop (3 passes in 15/16")),
			).toBe(true);
			expect(launched).toEqual([]);
			const st = replay(journal.events());
			expect(st.stopped).toBe(
				"early-stop gate A: 3/15 decisive first-trial passes <= 5",
			);
		} finally {
			process.env = saved;
		}
	});
});

describe("tb4 collection of a real run-trial.sh layout", () => {
	it("reads the trial's result, not Harbor's job-level result.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "tb4nest-"));
		const job = join(dir, "run-b1-task-a01");
		mkdirSync(join(job, "task__abc", "artifacts"), { recursive: true });
		writeFileSync(
			join(job, "result.json"),
			JSON.stringify({ id: "job", n_total_trials: 1 }),
		);
		writeFileSync(
			join(job, "task__abc", "result.json"),
			JSON.stringify(started(1)),
		);
		writeFileSync(
			join(job, "task__abc", "artifacts", "manifest.json"),
			JSON.stringify([{ source: "/app", status: "ok" }]),
		);
		expect(classify(readTrialDir(dir)!)).toMatchObject({
			kind: "valid",
			reward: 1,
		});
	});
	it("never collects while the trial's unit is still active", () => {
		const at = "2026-10-28T00:00:00Z";
		const boot = String(Date.parse("2026-10-27T23:00:00Z") / 1000);
		expect(
			readProbe(["active", boot, "/opt/tb4/jobs/x/x/t__1/result.json"], at),
		).toMatchObject({ unitActive: true, ready: false });
		expect(
			readProbe(["failed", boot, "/opt/tb4/jobs/x/x/t__1/result.json"], at),
		).toMatchObject({ ready: true });
		expect(readProbe(["inactive", boot, ""], at)).toMatchObject({
			ready: false,
			rebootedSinceLaunch: false,
		});
	});
});

describe("tb4 dead-attempt cleanup", () => {
	it("removes a killed attempt's containers when it is marked infra", () => {
		const { dir, journal } = newRun();
		journal.append({
			at: "2026-10-28T00:00:00Z",
			type: "launch",
			attemptId: "r1-b1-cpu-a-a01",
			task: "cpu-a",
			batch: "b1",
			host: "cpu-0",
		});
		const cleaned: string[] = [];
		const { ops } = fakeOps(() => ({ processAlive: false }));
		ops.cleanup = (_h, id) => {
			cleaned.push(id);
			return "removed containers of cpu-a__x";
		};
		const log = tick({
			runDir: dir,
			journal,
			hosts: [hosts[0]],
			tasks: [tasks[0]],
			ops,
			now: () => "t",
		});
		expect(cleaned).toEqual(["r1-b1-cpu-a-a01"]);
		expect(
			log.some((l) => l.startsWith("cleanup r1-b1-cpu-a-a01: removed")),
		).toBe(true);
	});
});

describe("tb4 provider-failure classification", () => {
	const line = (o: Record<string, unknown>) =>
		JSON.stringify({ at: "t", kind: "openai", ...o });
	const ok = line({
		phase: "stream",
		status: 200,
		terminal: { type: "response.completed" },
	});
	it("a final 429 or 5xx response is a provider failure (infra)", () => {
		expect(
			lastModelCallFailed(
				[ok, line({ phase: "response", status: 429 })].join("\n"),
			),
		).toContain('"status":429');
		expect(
			lastModelCallFailed(
				[ok, line({ phase: "response", status: 503 })].join("\n"),
			),
		).toContain('"status":503');
		expect(
			lastModelCallFailed([ok, line({ phase: "request" })].join("\n")),
		).not.toBeNull();
	});
	it("a final 4xx client error is the harness's own failure, not infra", () => {
		expect(
			lastModelCallFailed(
				[ok, line({ phase: "response", status: 400 })].join("\n"),
			),
		).toBeNull();
		expect(
			lastModelCallFailed(
				[ok, line({ phase: "response", status: 413 })].join("\n"),
			),
		).toBeNull();
	});
});

describe("tb4 outcome amendments", () => {
	it("an amend event overrides a finished attempt's outcome", () => {
		const ev: JournalEvent[] = [
			{
				at: "t",
				type: "run-start",
				runId: "r",
				commit: "c",
				bundleSha256: "0".repeat(64),
			},
			{ at: "t", type: "batch-open", batch: "b1" },
			{
				at: "t",
				type: "launch",
				attemptId: "x-a01",
				task: "x",
				batch: "b1",
				host: "h",
			},
			{
				at: "t",
				type: "finish",
				attemptId: "x-a01",
				outcome: { kind: "infra", reason: "HTTP 400" },
			},
			{
				at: "t2",
				type: "amend",
				attemptId: "x-a01",
				outcome: {
					kind: "valid",
					reward: 0,
					agentStartedAt: "2026-10-28T02:06:30Z",
					detail: "reclassified",
				},
				reason: "4xx is the harness's own failure",
			},
		];
		const st = replay(ev);
		expect(st.attempts.get("x-a01")?.outcome).toMatchObject({
			kind: "valid",
			reward: 0,
		});
		expect(
			scoredTrials(st)
				.get("x")
				?.scored.map((t) => t.reward),
		).toEqual([0]);
	});
});

describe("tb4 excluded tasks", () => {
	it("never launches an excluded task, even with a free GPU host", () => {
		const state = replay([
			{
				at: "t",
				type: "run-start",
				runId: "r",
				commit: "c",
				bundleSha256: "0".repeat(64),
			},
			{ at: "t", type: "batch-open", batch: "b1" },
		]);
		const out = nextLaunches({ state, tasks, hosts, exclude: ["gpu-a"] });
		expect(out.map((d) => d.task).sort()).toEqual(["cpu-a", "cpu-b"]);
	});
});

/* ---------- run safety: causes, review gate, error spike, staged scaling ---------- */

/** The 2026-10-27 incident's bridge log: a provider failure without a reason, then the builder stops. */
const INCIDENT_LOG = [
	'tool exec_command {"cmd":"ls"}',
	"Model provider failed {",
	"  kind: 'provider',",
	"  code: 'unknown',",
	"  retryable: false",
	"}",
	"builder stopped: The model request failed without a usable provider reason. Check the connection and retry. No fallback was used.",
].join("\n");

/** A run-trial.sh results dir: <attempt>/<attempt>/<task>__<id>/{result.json,trial.log,agent/,verifier/}. */
function trialDir(opts: {
	result: Record<string, unknown>;
	bridgeLog?: string;
	ctrf?: unknown;
}) {
	const root = mkdtempSync(join(tmpdir(), "tb4cause-"));
	const attempt = "r1-b1-cpu-a-a01";
	const trial = join(root, attempt, attempt, "cpu-a__Ab12cd");
	mkdirSync(join(trial, "agent"), { recursive: true });
	mkdirSync(join(trial, "verifier"), { recursive: true });
	writeFileSync(join(root, attempt, attempt, "result.json"), "{}");
	writeFileSync(join(trial, "result.json"), JSON.stringify(opts.result));
	writeFileSync(join(trial, "trial.log"), "harbor trial log\n");
	writeFileSync(join(trial, "verifier", "reward.txt"), "0\n");
	if (opts.bridgeLog !== undefined)
		writeFileSync(join(trial, "agent", "ytimesy-bridge.log"), opts.bridgeLog);
	if (opts.ctrf !== undefined)
		writeFileSync(
			join(trial, "verifier", "ctrf.json"),
			JSON.stringify(opts.ctrf),
		);
	return { root, jobDir: join(root, attempt) };
}

describe("tb4 failure causes", () => {
	it("the incident: a builder stop stays a scored 0 but carries an abnormal cause", () => {
		const { jobDir } = trialDir({
			result: started(0),
			bridgeLog: INCIDENT_LOG,
		});
		const result = readTrialDir(jobDir)!;
		const outcome = classify(result);
		expect(outcome).toMatchObject({ kind: "valid", reward: 0 });
		const cause = failureCause(outcome, result)!;
		expect(cause.cause).toBe("agent-stopped-abnormally");
		expect(cause.detail).toContain("builder stopped: The model request failed");
		expect(cause.detail).toContain("last code unknown");
		expect(needsReview(cause, reviewConfig({}))).toBe(true);
	});
	it("a normal end lists the verifier's failed tests and needs no review", () => {
		const { jobDir } = trialDir({
			result: started(0),
			bridgeLog:
				"tool exec_command {}\nreview round 1: findings returned to the builder\n",
			ctrf: {
				results: {
					summary: { tests: 3, passed: 1, failed: 2 },
					tests: [
						{ name: "test_a", status: "passed" },
						{ name: "test_b", status: "failed" },
						{ name: "test_c", status: "failed" },
					],
				},
			},
		});
		const result = readTrialDir(jobDir)!;
		const cause = failureCause(classify(result), result)!;
		expect(cause).toMatchObject({
			cause: "agent-finished",
			failedTests: { count: 2, names: ["test_b", "test_c"] },
		});
		expect(cause.detail).toBe("verifier: 2 failed test(s): test_b, test_c");
		expect(needsReview(cause, reviewConfig({}))).toBe(false);
	});
	it("timeout, budget cap, verifier error, infra and no evidence", () => {
		const valid0 = {
			kind: "valid",
			reward: 0,
			agentStartedAt: "x",
			detail: "",
		} as const;
		const ev = (e: Partial<ReturnType<typeof bridgeLogEvidence>>) => ({
			...started(0),
			evidence: { bridgeLog: true, providerFailures: 0, ...e },
		});
		expect(
			failureCause(valid0, {
				...ev({}),
				exception_info: {
					exception_type: "AgentTimeoutError",
					exception_message: "900 s",
				},
			})?.cause,
		).toBe("agent-timeout");
		expect(
			failureCause(
				valid0,
				ev(
					bridgeLogEvidence(
						"builder stopped: Trial spending cap reached: $12.0100 of $12.",
					),
				),
			)?.cause,
		).toBe("budget-cap");
		expect(
			failureCause(valid0, {
				...ev({}),
				exception_info: { exception_type: "VerifierTimeoutError" },
			})?.cause,
		).toBe("verifier-error");
		expect(
			failureCause({ kind: "infra", reason: "host restarted during the trial" })
				?.cause,
		).toBe("infra:host restarted during the trial");
		expect(failureCause(valid0, started(0))?.cause).toBe("unknown");
		expect(failureCause({ ...valid0, reward: 1 })).toBeNull();
		// Provider failures with no builder stop still need a look.
		expect(
			failureCause(
				valid0,
				ev(bridgeLogEvidence(INCIDENT_LOG.split("\nbuilder")[0])),
			),
		).toMatchObject({
			cause: "agent-stopped-abnormally",
		});
		expect(
			bridgeLogEvidence(
				"TypeError: Cannot read properties of undefined\n    at x",
			).uncaught,
		).toContain("TypeError");
	});
	it("keeps credentials and long lines out of the journal", () => {
		const line = sanitizeLine(
			`builder stopped: failed with Authorization: Bearer abcdefghijklmnop key=AKIAABCDEFGHIJKLMNOP sk-abcdefghijklmnopqrstu api_key=hunter2 ${"x".repeat(500)}`,
		);
		expect(line).not.toMatch(
			/abcdefghijklmnop|AKIAABCDEFGHIJKLMNOP|sk-abc|hunter2/,
		);
		expect(line.length).toBeLessThanOrEqual(300);
	});
	it("reads the TB4_* review settings", () => {
		expect(reviewConfig({})).toMatchObject({
			gate: true,
			spikeCount: 3,
			spikeMinutes: 30,
			stage1: true,
		});
		const c = reviewConfig({
			TB4_REVIEW_GATE: "off",
			TB4_STAGE1: "0",
			TB4_SPIKE_COUNT: "5",
			TB4_SPIKE_MINUTES: "10",
			TB4_REVIEW_BENIGN: "agent-finished",
		});
		expect(c).toMatchObject({
			gate: false,
			stage1: false,
			spikeCount: 5,
			spikeMinutes: 10,
		});
		expect([...c.benign]).toEqual(["agent-finished"]);
	});
});

describe("tb4 review gate", () => {
	const at = (min: number) =>
		new Date(Date.UTC(2026, 9, 28, 1, min)).toISOString();
	const gate = reviewConfig({ TB4_STAGE1: "off" });
	it("an abnormal end holds new launches, in-flight trials keep finishing, and an ack resumes", () => {
		const { dir, journal } = newRun();
		const many: Task[] = Array.from({ length: 4 }, (_, i) => ({
			name: `t${i}`,
			cpus: 2,
			memoryMb: 1024,
			gpus: 0,
			separateVerifier: false,
		}));
		const { jobDir } = trialDir({
			result: started(0),
			bridgeLog: INCIDENT_LOG,
		});
		const bad = readTrialDir(jobDir)!;
		let minute = 0;
		const now = () => at(minute);
		const { ops, launched } = fakeOps((id) =>
			id.includes("t0")
				? { result: bad }
				: id.includes("t1")
					? "pending"
					: { result: started(1) },
		);
		process.env.TB4_MAX_IN_FLIGHT = "2";
		try {
			tick({
				runDir: dir,
				journal,
				hosts: [hosts[0]],
				tasks: many,
				ops,
				now,
				review: gate,
			});
			expect(launched).toEqual(["r1-b1-t0-a01", "r1-b1-t1-a01"]);
			minute = 1;
			const log = tick({
				runDir: dir,
				journal,
				hosts: [hosts[0]],
				tasks: many,
				ops,
				now,
				review: gate,
			});
			expect(
				log.some((l) =>
					l.startsWith("REVIEW r1-b1-t0-a01: agent-stopped-abnormally"),
				),
			).toBe(true);
			expect(launched).toHaveLength(2); // room for one more, but held
			let s = replay(journal.events());
			expect(s.attempts.get("r1-b1-t0-a01")).toMatchObject({
				outcome: { kind: "valid", reward: 0 },
				cause: { cause: "agent-stopped-abnormally" },
			});
			expect([...s.reviews.keys()]).toEqual(["r1-b1-t0-a01"]);
			// The in-flight trial is still observed and collected while held.
			minute = 2;
			tick({
				runDir: dir,
				journal,
				hosts: [hosts[0]],
				tasks: many,
				ops,
				now,
				review: gate,
			});
			expect(launched).toHaveLength(2);
			journal.append({
				at: at(3),
				type: "ack",
				key: "r1-b1-t0-a01",
				note: "read the log: context-window fallback; fixed",
			});
			s = replay(journal.events());
			expect(s.reviews.size).toBe(0);
			minute = 4;
			tick({
				runDir: dir,
				journal,
				hosts: [hosts[0]],
				tasks: many,
				ops,
				now,
				review: gate,
			});
			expect(launched).toContain("r1-b1-t2-a01");
			const digest = failureDigest(dir, replay(journal.events()));
			expect(digest).toEqual([
				expect.objectContaining({
					attemptId: "r1-b1-t0-a01",
					outcome: "valid 0",
					cause: "agent-stopped-abnormally",
					review: "acked: read the log: context-window fallback; fixed",
				}),
			]);
		} finally {
			delete process.env.TB4_MAX_IN_FLIGHT;
		}
	});
	it("ack all clears every pending review; the watchdog alerts while one is pending", () => {
		const ev: JournalEvent[] = [
			{
				at: "t",
				type: "run-start",
				runId: "r",
				commit: "c",
				bundleSha256: "0".repeat(64),
			},
			{
				at: "t",
				type: "review-needed",
				attemptId: "a",
				task: "x",
				cause: "verifier-error",
				detail: "",
			},
			{
				at: "t",
				type: "review-needed",
				attemptId: "b",
				task: "y",
				cause: "unknown",
				detail: "",
			},
		];
		const pending = replay(ev);
		expect(nextLaunches({ state: pending, tasks, hosts })).toEqual([]);
		const w = watch({
			now: 0,
			state: pending,
			logSilenceMs: new Map(),
			unhealthyHosts: [],
			bedrockErrorsLast15m: { throttles: 0, serverErrors: 0 },
			modelSpendUsd: 0,
			infraSpendUsd: 0,
			alerted: { model: [], infra: [] },
			controllerActive: true,
			lastProgressAt: 0,
		});
		expect(w.alerts.map((a) => a.key)).toEqual(["review:a", "review:b"]);
		expect(
			replay([...ev, { at: "t", type: "ack", key: "all", note: "both read" }])
				.reviews.size,
		).toBe(0);
	});
	it("an old journal without causes still replays, and the digest derives causes from results", () => {
		const { dir, journal } = newRun();
		journal.append({
			at: at(0),
			type: "launch",
			attemptId: "r1-b1-cpu-a-a01",
			task: "cpu-a",
			batch: "b1",
			host: "cpu-0",
		});
		journal.append({
			at: at(5),
			type: "launch",
			attemptId: "r1-b1-cpu-b-a01",
			task: "cpu-b",
			batch: "b1",
			host: "cpu-0",
		});
		journal.append({
			at: at(9),
			type: "finish",
			attemptId: "r1-b1-cpu-b-a01",
			outcome: { kind: "infra", reason: "host restarted during the trial" },
		});
		journal.append({
			at: at(10),
			type: "finish",
			attemptId: "r1-b1-cpu-a-a01",
			outcome: {
				kind: "valid",
				reward: 0,
				agentStartedAt: at(1),
				detail: "reward 0",
			},
		});
		const { root } = trialDir({ result: started(0), bridgeLog: INCIDENT_LOG });
		mkdirSync(join(dir, "results"), { recursive: true });
		renameSync(
			join(root, "r1-b1-cpu-a-a01"),
			join(dir, "results", "r1-b1-cpu-a-a01"),
		);
		const s = replay(journal.events());
		expect(s.reviews.size).toBe(0);
		expect(
			failureDigest(dir, s).map((r) => [r.attemptId, r.cause, r.derived]),
		).toEqual([
			["r1-b1-cpu-b-a01", "infra:host restarted during the trial", true],
			["r1-b1-cpu-a-a01", "agent-stopped-abnormally", true],
		]);
	});
});

describe("tb4 error-spike stop", () => {
	const at = (min: number) =>
		new Date(Date.UTC(2026, 9, 28, 1, 0) + min * 60_000).toISOString();
	const cfg = reviewConfig({});
	const abnormal = {
		cause: "agent-stopped-abnormally",
		detail: "builder stopped: x",
	};
	function finished(rows: [number, { cause: string; detail: string }][]) {
		const ev: JournalEvent[] = [
			{
				at: at(0),
				type: "run-start",
				runId: "r",
				commit: "c",
				bundleSha256: "0".repeat(64),
			},
			{ at: at(0), type: "batch-open", batch: "b1" },
		];
		rows.forEach(([min, cause], i) => {
			ev.push({
				at: at(0),
				type: "launch",
				attemptId: `a${i}`,
				task: `t${i}`,
				batch: "b1",
				host: "h",
			});
			ev.push({
				at: at(min),
				type: "finish",
				attemptId: `a${i}`,
				outcome: cause.cause.startsWith("infra")
					? { kind: "infra", reason: "x" }
					: { kind: "valid", reward: 0, agentStartedAt: at(0), detail: "" },
				cause,
			});
		});
		return replay(ev);
	}
	it("stops at 3 abnormal ends within 30 min, not 2, not spread out, not infra", () => {
		expect(
			errorSpike(
				finished([
					[10, abnormal],
					[20, abnormal],
					[35, abnormal],
				]),
				Date.parse(at(36)),
				cfg,
			),
		).toContain(
			"error spike: 3 abnormal trial ends (agent-stopped-abnormally) within 30 min",
		);
		expect(
			errorSpike(
				finished([
					[10, abnormal],
					[20, abnormal],
				]),
				Date.parse(at(36)),
				cfg,
			),
		).toBeNull();
		expect(
			errorSpike(
				finished([
					[0, abnormal],
					[20, abnormal],
					[45, abnormal],
				]),
				Date.parse(at(46)),
				cfg,
			),
		).toBeNull();
		const infra = { cause: "infra:host restarted", detail: "" };
		expect(
			errorSpike(
				finished([
					[10, infra],
					[11, infra],
					[12, abnormal],
				]),
				Date.parse(at(13)),
				cfg,
			),
		).toBeNull();
		const benign = { cause: "agent-finished", detail: "" };
		expect(
			errorSpike(
				finished([
					[10, benign],
					[11, benign],
					[12, benign],
				]),
				Date.parse(at(13)),
				cfg,
			),
		).toBeNull();
	});
	it("the tick journals the stop and launches nothing more", () => {
		const { dir, journal } = newRun();
		const many: Task[] = Array.from({ length: 6 }, (_, i) => ({
			name: `t${i}`,
			cpus: 2,
			memoryMb: 1024,
			gpus: 0,
			separateVerifier: false,
		}));
		const { jobDir } = trialDir({
			result: started(0),
			bridgeLog: INCIDENT_LOG,
		});
		const bad = readTrialDir(jobDir)!;
		let minute = 0;
		const { ops, launched } = fakeOps((id) =>
			Number(id.match(/-t(\d)-/)?.[1]) < 3 ? { result: bad } : "pending",
		);
		// Gate off: the spike alone must stop the run.
		const review = reviewConfig({ TB4_REVIEW_GATE: "off", TB4_STAGE1: "off" });
		tick({
			runDir: dir,
			journal,
			hosts: [hosts[0]],
			tasks: many,
			ops,
			now: () => at(minute),
			review,
		});
		expect(launched).toHaveLength(6);
		minute = 5;
		const log = tick({
			runDir: dir,
			journal,
			hosts: [hosts[0]],
			tasks: many,
			ops,
			now: () => at(minute),
			review,
		});
		expect(
			log.some((l) => l.startsWith("STOP error spike: 3 abnormal trial ends")),
		).toBe(true);
		expect(replay(journal.events()).stopped).toContain("error spike");
		minute = 6;
		tick({
			runDir: dir,
			journal,
			hosts: [hosts[0]],
			tasks: many,
			ops,
			now: () => at(minute),
			review,
		});
		expect(launched).toHaveLength(6);
	});
});

describe("tb4 staged scaling", () => {
	const at = (min: number) =>
		new Date(Date.UTC(2026, 9, 28, 1, 0) + min * 60_000).toISOString();
	function openAllRun() {
		const r = newRun();
		r.journal.append({ at: "t", type: "batch-open", batch: "b2" });
		return r;
	}
	it("launches one trial per task, journals stage-review when they are done, and waits for ack stage1", () => {
		const { dir, journal } = openAllRun();
		const { ops, launched } = fakeOps();
		const review = reviewConfig({});
		const run = (min: number) =>
			tick({
				runDir: dir,
				journal,
				hosts,
				tasks,
				ops,
				now: () => at(min),
				review,
			});
		run(0);
		expect(launched.sort()).toEqual([
			"r1-b1-cpu-a-a01",
			"r1-b1-cpu-b-a01",
			"r1-b1-gpu-a-a01",
		]);
		const log = run(1); // all three pass and are collected
		expect(
			log.some((l) => l.startsWith("STAGE-REVIEW stage 1 done: 3 of 3")),
		).toBe(true);
		expect(launched).toHaveLength(3);
		run(2);
		expect(launched).toHaveLength(3);
		expect(replay(journal.events()).reviews.has("stage1")).toBe(true);
		journal.append({
			at: at(3),
			type: "ack",
			key: "stage1",
			note: "every stage-1 log read",
		});
		run(4);
		expect(launched.filter((l) => l.includes("-b2-")).length).toBeGreaterThan(
			0,
		);
		// The stage review is never journaled twice.
		run(5);
		expect(
			journal.events().filter((e) => e.type === "stage-review"),
		).toHaveLength(1);
	});
	it("front-loaded tasks get only their stage-1 trial first; excluded tasks do not hold stage 1", () => {
		const two = (i: number): Task => ({
			name: `t${i}`,
			cpus: 2,
			memoryMb: 1024,
			gpus: 0,
			separateVerifier: false,
		});
		const { journal } = openAllRun();
		const state = replay(journal.events());
		const d = nextLaunches({
			state,
			tasks: [two(0), two(1)],
			hosts: [hosts[0]],
			frontload: ["t1"],
			stage1: true,
		});
		expect(d.map((x) => `${x.task}/${x.batch}`)).toEqual(["t1/b1", "t0/b1"]);
		for (const x of d) {
			journal.append({
				at: "t",
				type: "launch",
				attemptId: x.attemptId,
				task: x.task,
				batch: x.batch,
				host: x.host,
			});
			if (x.task === "t1")
				journal.append({
					at: "t",
					type: "finish",
					attemptId: x.attemptId,
					outcome: {
						kind: "valid",
						reward: 1,
						agentStartedAt: "t",
						detail: "",
					},
				});
		}
		expect(stage1Complete(replay(journal.events()), [two(0), two(1)])).toBe(
			false,
		);
		// t0 still running holds stage 1 unless it is excluded (run elsewhere).
		expect(
			stage1Complete(replay(journal.events()), [two(0), two(1)], ["t0"]),
		).toBe(true);
		expect(
			stage1Complete(replay(journal.events()), [two(1), two(2)], ["t2"]),
		).toBe(true);
	});
	it("an older journal with batch-2 trials already launched is not held", () => {
		const { journal } = openAllRun();
		journal.append({
			at: "t",
			type: "launch",
			attemptId: "r1-b2-cpu-a-a01",
			task: "cpu-a",
			batch: "b2",
			host: "cpu-0",
		});
		const state = replay(journal.events());
		expect(state.stage1Released).toBe(true);
		expect(
			nextLaunches({ state, tasks, hosts, stage1: true }).some(
				(d) => d.batch === "b2",
			),
		).toBe(true);
	});
});

describe("tb4 egress preflight", () => {
	it("tunnels only to the model host and records every blocked destination", async () => {
		const target = createServer((_q, r) => r.end("model"));
		await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
		const tp = (target.address() as { port: number }).port;
		const g = await startEgressGuard({ allow: ["127.0.0.1"] });
		const tunnel = (host: string) =>
			new Promise<string>((resolve) => {
				const s = netConnect(g.port, "127.0.0.1", () =>
					s.write(`CONNECT ${host}:${tp} HTTP/1.1\r\nHost: ${host}\r\n\r\n`),
				);
				s.once("data", (d) => {
					resolve(d.toString().split("\r\n")[0]);
					s.destroy();
				});
			});
		expect(await tunnel("127.0.0.1")).toBe(
			"HTTP/1.1 200 Connection Established",
		);
		expect(await tunnel("openrouter.ai")).toBe("HTTP/1.1 403 Forbidden");
		const plain = await new Promise<number>((resolve) => {
			const s = netConnect(g.port, "127.0.0.1", () =>
				s.write(
					"GET http://models.dev/api.json HTTP/1.1\r\nHost: models.dev\r\nConnection: close\r\n\r\n",
				),
			);
			s.once("data", (d) => {
				resolve(Number(d.toString().split(" ")[1]));
				s.destroy();
			});
		});
		expect(plain).toBe(403);
		expect(g.entries().map((e) => [e.host, e.allowed])).toEqual([
			["127.0.0.1", true],
			["openrouter.ai", false],
			["models.dev", false],
		]);
		expect(
			egressAllowed("bedrock-runtime.us-east-1.amazonaws.com", [
				".amazonaws.com",
			]),
		).toBe(true);
		g.server.close();
		target.close();
	});
	it("passes only when the trial started, used the guard, and logged the expected context window", () => {
		const entries = [
			{
				at: "t",
				method: "CONNECT",
				host: "model.example",
				port: 443,
				allowed: true,
			},
			{
				at: "t",
				method: "CONNECT",
				host: "openrouter.ai",
				port: 443,
				allowed: false,
			},
		];
		const ok = egressPreflightVerdict({
			bridgeLog: "context window 400000 (catalog)\ntool exec_command {}\n",
			entries,
			modelHost: "model.example",
			expectedContextWindow: 400_000,
		});
		expect(ok).toMatchObject({ ok: true, blocked: ["openrouter.ai:443"] });
		const fallback = egressPreflightVerdict({
			bridgeLog: `context window 128,000\n${INCIDENT_LOG}`,
			entries,
			modelHost: "model.example",
			expectedContextWindow: 400_000,
		});
		expect(fallback.ok).toBe(false);
		expect(fallback.problems.join("\n")).toMatch(
			/builder stopped[\s\S]*context window 128000, expected 400000/,
		);
		expect(
			egressPreflightVerdict({
				bridgeLog: "",
				entries: [],
				modelHost: "model.example",
				expectedContextWindow: 1,
			}).problems,
		).toHaveLength(2);
		expect(contextWindowFromLog("no window here")).toBeNull();
	});
});
