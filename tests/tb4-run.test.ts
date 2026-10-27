import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findTaskTomls, type HostOps, loadTasks, readTrialDir, tick } from "../scripts/tb4-run/controller.ts";
import { startFaultProxy } from "../scripts/tb4-run/faults/fault-proxy.ts";
import {
	batch2Decision,
	classify,
	fitsCpu,
	HOST_RESERVED_VCPU,
	hostCpuBudget,
	TRIAL_OVERHEAD_VCPU,
	taskFromToml,
	type Host,
	type HostObservation,
	Journal,
	ledgerTotals,
	earlyStopDecision,
	floorCeiling,
	nextLaunches,
	pairedComparison,
	SPEND,
	passAtK,
	replay,
	scoredTrials,
	type Task,
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
function fakeOps(script: (id: string) => Partial<HostObservation> | "pending" = () => ({ result: started(1) })) {
	const launched: string[] = [];
	const ops: HostOps = {
		launch: (_h, id) => void launched.push(id),
		observe: (_h, id) => {
			const s = script(id);
			if (s === "pending") return { processAlive: true, hostReachable: true, hostRebootedSinceLaunch: false };
			return { processAlive: false, hostReachable: true, hostRebootedSinceLaunch: false, ...s };
		},
		collect: () => ["controller:x"],
		health: () => ({ ok: true, why: "" }),
	};
	return { ops, launched };
}
function newRun() {
	const dir = mkdtempSync(join(tmpdir(), "tb4run-"));
	const journal = new Journal(join(dir, "journal.jsonl"));
	journal.append({ at: "t", type: "run-start", runId: "r1", commit: "abc", bundleSha256: "0".repeat(64) });
	journal.append({ at: "t", type: "batch-open", batch: "b1" });
	return { dir, journal };
}

describe("tb4 controller", () => {
	it("launches one batch-1 trial per task, GPU on the GPU host, and finishes them", () => {
		const { dir, journal } = newRun();
		const { ops, launched } = fakeOps();
		tick({ runDir: dir, journal, hosts, tasks, ops });
		expect(launched.sort()).toEqual(["r1-b1-cpu-a-a01", "r1-b1-cpu-b-a01", "r1-b1-gpu-a-a01"]);
		expect(replay(journal.events()).attempts.get("r1-b1-gpu-a-a01")?.host).toBe("gpu-0");
		tick({ runDir: dir, journal, hosts, tasks, ops });
		const s = replay(journal.events());
		expect([...s.attempts.values()].every((a) => a.outcome?.kind === "valid")).toBe(true);
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
		journal.append({ at: "t", type: "launch", attemptId: "r1-b1-cpu-a-a01", task: "cpu-a", batch: "b1", host: "cpu-0" });
		const { ops, launched } = fakeOps(() => ({}));
		tick({ runDir: dir, journal, hosts, tasks, ops });
		const s = replay(journal.events());
		expect(s.attempts.get("r1-b1-cpu-a-a01")?.outcome).toMatchObject({ kind: "infra" });
		expect(launched).toContain("r1-b1-cpu-a-a02");
	});

	it("host restart mid-trial: infra, rerun; a graded trial is never rerun", () => {
		const { dir, journal } = newRun();
		const { ops, launched } = fakeOps((id) => (id.includes("cpu-a-a01") ? { hostRebootedSinceLaunch: true } : { result: started(0) }));
		tick({ runDir: dir, journal, hosts, tasks, ops });
		tick({ runDir: dir, journal, hosts, tasks, ops });
		expect(launched.filter((l) => l.includes("cpu-a"))).toEqual(["r1-b1-cpu-a-a01", "r1-b1-cpu-a-a02"]);
		expect(launched.filter((l) => l.includes("cpu-b"))).toEqual(["r1-b1-cpu-b-a01"]); // graded 0: kept
	});

	it("stops at the attempt cap", () => {
		const { dir, journal } = newRun();
		const { ops, launched } = fakeOps(() => ({ result: { agent_execution: { started_at: null } } }));
		for (let i = 0; i < 10; i++) tick({ runDir: dir, journal, hosts, tasks: [tasks[0]], ops });
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
		expect(nextLaunches({ state: replay(journal.events()), tasks, hosts })).toEqual([]);
	});

	it("reads a Harbor job dir with transport and manifest evidence", () => {
		const dir = mkdtempSync(join(tmpdir(), "tb4job-"));
		mkdirSync(join(dir, "t__x", "artifacts"), { recursive: true });
		writeFileSync(join(dir, "t__x", "result.json"), JSON.stringify(started(1)));
		writeFileSync(join(dir, "t__x", "artifacts", "manifest.json"), JSON.stringify([{ source: "/app", status: "failed" }]));
		expect(classify(readTrialDir(dir)!)).toMatchObject({ kind: "infra", reason: "agent /app did not reach the grader" });
	});
});

describe("tb4 host CPU budget", () => {
	const host: Host = { name: "cpu-0", kind: "cpu", vcpu: 64, memoryMb: 1 << 30, address: "x" };
	const two = (i: number): Task => ({ name: `t${i}`, cpus: 2, memoryMb: 1024, gpus: 0, separateVerifier: true });

	it("keeps the sum of in-flight task cpus plus overhead within vCPU minus the reserve", () => {
		const many = Array.from({ length: 40 }, (_, i) => two(i));
		const { journal } = newRun();
		const launches = nextLaunches({ state: replay(journal.events()), tasks: many, hosts: [host] });
		// 2 cpus + 1 overhead per trial in 64 - 2 = 62: 20 trials, not 32.
		expect(launches).toHaveLength(Math.floor(hostCpuBudget(host) / (2 + TRIAL_OVERHEAD_VCPU)));
		expect(launches.length * (2 + TRIAL_OVERHEAD_VCPU)).toBeLessThanOrEqual(host.vcpu - HOST_RESERVED_VCPU);
	});

	it("counts running trials from the journal", () => {
		const { journal } = newRun();
		for (let i = 0; i < 19; i++)
			journal.append({ at: "t", type: "launch", attemptId: `r1-b1-t${i}-a01`, task: `t${i}`, batch: "b1", host: "cpu-0" });
		const many = Array.from({ length: 40 }, (_, i) => two(i));
		expect(nextLaunches({ state: replay(journal.events()), tasks: many, hosts: [host] })).toHaveLength(1);
	});

	it("an idle host takes one task as large as itself, and only that one", () => {
		const p5: Host = { name: "gpu-0", kind: "gpu", vcpu: 16, memoryMb: 262144, address: "y" };
		const jax: Task = { name: "jax", cpus: 16, memoryMb: 32768, gpus: 1, separateVerifier: true };
		expect(fitsCpu(p5, { vcpu: 0, trials: 0 }, jax)).toBe(true);
		expect(fitsCpu(p5, { vcpu: 5, trials: 1 }, { cpus: 2 })).toBe(true);
		expect(fitsCpu(p5, { vcpu: 5, trials: 1 }, { cpus: 16 })).toBe(false);
		const { journal } = newRun();
		expect(nextLaunches({ state: replay(journal.events()), tasks: [jax], hosts: [p5] })).toHaveLength(1);
	});

	it("reads cpus as max(environment, separate verifier) from task.toml in Harbor's cache layout", () => {
		expect(
			taskFromToml("x", {
				environment: { cpus: 4, memory_mb: 8192, gpus: 0 },
				verifier: { environment_mode: "separate", environment: { cpus: 6, memory_mb: 4096 } },
			}),
		).toEqual({ name: "x", cpus: 6, memoryMb: 8192, gpus: 0, separateVerifier: true });
		const root = mkdtempSync(join(tmpdir(), "tb4cache-"));
		mkdirSync(join(root, "vpp", "abc123"), { recursive: true });
		writeFileSync(
			join(root, "vpp", "abc123", "task.toml"),
			'[verifier]\nenvironment_mode = "separate"\n[verifier.environment]\ncpus = 2\nmemory_mb = 8192\n[environment]\ncpus = 2\nmemory_mb = 8192\ngpus = 0\n',
		);
		expect([...findTaskTomls(root).keys()]).toEqual(["vpp"]);
		expect(loadTasks(root)).toEqual([{ name: "vpp", cpus: 2, memoryMb: 8192, gpus: 0, separateVerifier: true }]);
	});
});

describe("tb4 scoring", () => {
	it("classifies per the rule", () => {
		expect(classify(started(0))).toMatchObject({ kind: "valid", reward: 0 });
		expect(classify({ agent_execution: { started_at: "x" }, verifier_result: { rewards: { reward: null } } })).toMatchObject({ kind: "infra" });
		expect(classify({ ...started(1), gpuAsserted: false })).toMatchObject({ kind: "infra" });
		expect(classify({ ...started(1), harnessStoppedOnModelFailure: true, unrecoveredTransportFailure: "{}" })).toMatchObject({ kind: "infra" });
		expect(classify({ ...started(0), harnessStoppedOnModelFailure: true, unrecoveredTransportFailure: null })).toMatchObject({ kind: "valid" });
	});

	it("first trials by agent start per batch; extras disclosed", () => {
		const { journal } = newRun();
		journal.append({ at: "t", type: "batch-open", batch: "b2" });
		const add = (id: string, batch: "b1" | "b2", at: string, r: number) => {
			journal.append({ at, type: "launch", attemptId: id, task: "cpu-a", batch, host: "cpu-0" });
			journal.append({ at, type: "finish", attemptId: id, outcome: { kind: "valid", reward: r, agentStartedAt: at, detail: "" } });
		};
		add("b1x", "b1", "2026-10-22T01:00:00Z", 1);
		add("b1y", "b1", "2026-10-22T02:00:00Z", 0);
		for (let i = 0; i < 5; i++) add(`b2-${i}`, "b2", `2026-10-23T0${i}:00:00Z`, i % 2);
		const s = scoredTrials(replay(journal.events())).get("cpu-a")!;
		expect(s.scored.map((t) => t.attemptId)).toEqual(["b1x", "b2-0", "b2-1", "b2-2", "b2-3"]);
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
		expect(r.alerts.map((a) => a.key).sort()).toEqual(["bedrock-throttle", "controller-down", "host:cpu-1", "model-spend-0.8", "silent:a1"]);
		expect(r.actions).toEqual(["restart-controller", "pause:bedrock-throttle"]);
		expect(watch({ ...base, modelSpendUsd: 900, alerted: { model: [0.5, 0.8], infra: [] } }).actions).toEqual(["stop:model-cap"]);
	});
	it("ledger totals and Bedrock error counting", () => {
		expect(ledgerTotals([
			{ type: "reserve", trial: "a", usd: 12 },
			{ type: "settle", trial: "a", usd: 1.5 },
			{ type: "reserve", trial: "b", usd: 12 },
		])).toEqual({ settled: 1.5, reserved: 12 });
		const now = Date.parse("2026-10-22T00:20:00Z");
		const lines = [
			JSON.stringify({ at: "2026-10-22T00:10:00Z", status: 429 }),
			JSON.stringify({ at: "2026-10-22T00:11:00Z", code: "ThrottlingException" }),
			JSON.stringify({ at: "2026-10-22T00:12:00Z", status: 503 }),
			JSON.stringify({ at: "2026-10-21T00:12:00Z", status: 429 }),
		];
		expect(bedrockErrors(lines, now - 15 * 60_000)).toEqual({ throttles: 2, serverErrors: 1 });
	});
	it("holds repeat alerts for an hour", async () => {
		const ws = { alerted: { model: [], infra: [] }, lastSent: {}, lastProgressAt: 0, lastFinished: 0 };
		const posts: string[] = [];
		const post = (async (_u: unknown, init: { body: string }) => void posts.push(init.body)) as unknown as typeof fetch;
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
				res.end('event: response.completed\ndata: {}\n\n');
			} else res.end("ok");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const a = server.address();
		return { server, url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}` };
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
		const t = await startFaultProxy({ upstream: up.url, fault: "throttle", nth: 1 });
		const r = await fetch(`http://127.0.0.1:${t.port}/x`);
		expect(r.status).toBe(429);
		expect(r.headers.get("x-amzn-errortype")).toBe("ThrottlingException");
		const o = await startFaultProxy({ upstream: up.url, fault: "outage", nth: 1, outageSec: 60 });
		await expect(fetch(`http://127.0.0.1:${o.port}/x`)).rejects.toThrow();
		await expect(fetch(`http://127.0.0.1:${o.port}/x`)).rejects.toThrow();
		const s = await startFaultProxy({ upstream: up.url, fault: "reset", nth: 1 });
		await expect(fetch(`http://127.0.0.1:${s.port}/sse`).then((x) => x.text())).rejects.toThrow();
		for (const x of [t, o, s]) x.server.close();
		up.server.close();
	});
});

describe("tb4 Astra x5 run rules", () => {
	const trial = (reward: number, i: number) => ({ attemptId: `a${i}`, batch: "b1" as const, reward, agentStartedAt: `t${i}` });
	it("floor counts missing trials as fails, ceiling as passes", () => {
		const perTask = new Map([
			["x", { scored: [trial(1, 1), trial(1, 2), trial(0, 3)] }],
			["y", { scored: [trial(1, 4), trial(1, 5), trial(1, 6), trial(1, 7), trial(1, 8)] }],
		]);
		const b = floorCeiling(perTask, ["x", "y", "z"], 5);
		expect(b.missingTrials).toBe(2 + 0 + 5);
		expect(b.floorPct).toBeCloseTo((100 * (2 / 5 + 1 + 0)) / 3);
		expect(b.ceilingPct).toBeCloseTo((100 * (4 / 5 + 1 + 1)) / 3);
	});
	it("stops early only when the ceiling is below the competitor", () => {
		expect(earlyStopDecision({ floorPct: 40, ceilingPct: 55, missingTrials: 9 }, 57.9).stop).toBe(true);
		expect(earlyStopDecision({ floorPct: 60, ceilingPct: 70, missingTrials: 9 }, 57.9)).toMatchObject({ stop: false });
		expect(earlyStopDecision({ floorPct: 60, ceilingPct: 70, missingTrials: 9 }, 57.9).why).toContain("ahead");
		expect(earlyStopDecision({ floorPct: 50, ceilingPct: 65, missingTrials: 9 }, 57.9).why).toContain("undecided");
	});
	it("open-all journals both batches at init", () => {
		const dir = mkdtempSync(join(tmpdir(), "tb4astra-"));
		const journal = new Journal(join(dir, "journal.jsonl"));
		journal.append({ at: "t", type: "run-start", runId: "r", commit: "c", bundleSha256: "0".repeat(64) });
		journal.append({ at: "t", type: "batch-open", batch: "b1" });
		journal.append({ at: "t", type: "batch-open", batch: "b2" });
		expect([...replay(journal.events()).openBatches].sort()).toEqual(["b1", "b2"]);
	});
	it("stops launches at the cap minus the margin for running trials", () => {
		const saved = { cap: SPEND.modelTotalCapUsd, margin: SPEND.modelStopMarginUsd };
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
			expect(watch({ ...input, modelSpendUsd: 2150 }).actions).toEqual(["stop:model-cap"]);
		} finally {
			Object.assign(SPEND, { modelTotalCapUsd: saved.cap, modelStopMarginUsd: saved.margin });
		}
	});
	it("ships a trial cap for every TB4 task, at most the bridge maximum", async () => {
		const { readFileSync } = await import("node:fs");
		const caps = JSON.parse(readFileSync("scripts/tb4-run/astra-trial-caps.json", "utf8")) as Record<string, number>;
		const codex = JSON.parse(readFileSync("benchmarks/evaluation/codex-astra-public-job.json", "utf8")) as { tasks: Record<string, unknown> };
		expect(Object.keys(caps).sort()).toEqual(Object.keys(codex.tasks).sort());
		expect(Math.max(...Object.values(caps))).toBeLessThanOrEqual(100);
	});
});
