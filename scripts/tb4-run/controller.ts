/**
 * TB4 run controller (docs/tb4-run-controller.md). Runs on the controller
 * instance under systemd (tb4-controller.service); one owner per run.
 *
 *   node --import tsx scripts/tb4-run/controller.ts <command> --run-dir /opt/tb4/run
 *     init --run-id tb4b-20261022 --commit <sha> --bundle-sha256 <hex>
 *     loop                 reconcile + launch every 30 s (the service's command)
 *     tick                 one reconcile + launch pass
 *     status               counts per batch, in flight, paused/stopped
 *     open-batch b2 --owner <name>   only when the batch-2 rule says go (or --override with a dated amendment)
 *     pause <reason> | resume | stop <reason>
 *     ack <attemptId|stage1|all> --note "<what you read and why launches may resume>"
 *     failures             every non-pass with its cause, ordered by finish time
 *     score [--codex benchmarks/evaluation/codex-public-job.json] [--reason-job <reason-job.json>]
 *     init ... --open-all            Astra x5 rule: both batches open at init, no batch-2 gate
 *
 *     gpu-status | gpu-budget <usd> | gpu-spent <usd> | gpu-costs [--dataset <dir>]
 *                          the GPU lane (TB4_GPU_LANE=daytona + TB4_GPU_RUNNER=<host>,
 *                          or TB4_GPU_LANE=docker + TB4_GPU_HOST=<p5 host>)
 *
 *     tasks [--dataset <dir>]   write tasks.json from each task.toml (default: Harbor's
 *                          dataset cache ~/.cache/harbor/tasks/packages/terminal-bench)
 *
 * <run-dir>/hosts.json (written by provision.py) and <run-dir>/tasks.json
 * (written by `tasks`) describe the fleet and the dataset. The journal
 * <run-dir>/journal.jsonl is the only state.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	awsGpuHostHourly,
	type HostMarket,
	hostTypicalUsd,
	hostWorstCaseUsd,
	typicalUsd,
	worstCaseUsd,
} from "./gpu-cost.ts";
import {
	type BillingInterval,
	GPU_LANE_JOURNAL,
	type GpuLaneOps,
	type GpuTarget,
	gpuLaneTick,
	hostIntervals,
	isLaneHost,
	type LaneConfig,
	type LaneEvent,
	type LiveSandbox,
	laneConfig,
	laneStatus,
	readBudget,
	writeBudget,
} from "./gpu-lane.ts";
import {
	BATCHES,
	batch2Decision,
	bridgeLogEvidence,
	causeKind,
	ctrfFailures,
	earlyStopDecision,
	earlyStopGates,
	errorSpike,
	failureCause,
	finishAttempt,
	floorCeiling,
	type HarborResult,
	type Host,
	type HostObservation,
	Journal,
	lastModelCallFailed,
	nextLaunches,
	pairedComparison,
	passAt1,
	type ReviewConfig,
	type RunState,
	reconcile,
	replay,
	reviewConfig,
	sanitizeLine,
	scoredTrials,
	stage1Complete,
	type Task,
	type TrialOutcome,
	taskFromToml,
} from "./lib.ts";

/** Harbor's dataset cache, the one preflight.ts and run-trial.sh resolve tasks from. */
export const HARBOR_TASK_CACHE = join(
	homedir(),
	".cache/harbor/tasks/packages/terminal-bench",
);

/**
 * task.toml paths per task. Accepts Harbor's cache (<task>/<content hash>/task.toml;
 * one hash per task is expected, the newest wins) or a flat dataset (<task>/task.toml).
 */
export function findTaskTomls(root: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const name of readdirSync(root)) {
		const flat = join(root, name, "task.toml");
		if (existsSync(flat)) {
			out.set(name, flat);
			continue;
		}
		const dir = join(root, name);
		let best: { path: string; mtime: number } | undefined;
		for (const hash of existsSync(dir) && statSync(dir).isDirectory()
			? readdirSync(dir)
			: []) {
			const path = join(dir, hash, "task.toml");
			if (!existsSync(path)) continue;
			const mtime = statSync(path).mtimeMs;
			if (!best || mtime > best.mtime) best = { path, mtime };
		}
		if (best) out.set(name, best.path);
	}
	return out;
}

/** Parse every task.toml with one isolated python call (tomllib) and build the Task list. */
export function loadTasks(root: string): Task[] {
	const tomls = findTaskTomls(root);
	if (!tomls.size) throw new Error(`no task.toml under ${root}`);
	const parsed = JSON.parse(
		execFileSync(
			"python3",
			[
				"-I",
				"-c",
				"import json,sys,tomllib\nprint(json.dumps({p: tomllib.load(open(p,'rb')) for p in sys.argv[1:]}))",
				...tomls.values(),
			],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		),
	) as Record<string, Record<string, unknown>>;
	return [...tomls]
		.map(([name, path]) => taskFromToml(name, parsed[path]))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything that touches a host; replaced by a fake in tests. */
export type HostOps = {
	launch(host: Host, attemptId: string, task: string): void;
	observe(host: Host, attemptId: string, launchedAt: string): HostObservation;
	collect(host: Host, attemptId: string): string[];
	health(host: Host): { ok: boolean; why: string };
	/** Removes a dead attempt's task containers and networks (a killed unit leaves them running). */
	cleanup?(host: Host, attemptId: string): string;
};

const sh = (cmd: string, args: string[], timeoutMs = 60_000) =>
	execFileSync(cmd, args, {
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: ["ignore", "pipe", "pipe"],
	});
const ssh = (host: Host, remote: string, timeoutMs = 60_000) =>
	sh(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"ServerAliveInterval=15",
			host.address,
			remote,
		],
		timeoutMs,
	);
const safeId = (id: string) => {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`unsafe id ${id}`);
	return id;
};

/** Reads one Harbor job dir (controller copy) into a HarborResult with the collector's fields. */
export function readTrialDir(jobDir: string): HarborResult | undefined {
	if (!existsSync(jobDir)) return undefined;
	// run-trial.sh's layout is <jobs-dir>/<job>/<task>__<id>/result.json; <job>/result.json is
	// Harbor's job-level summary, written when the job starts. Only a trial dir (<task>__<id>)
	// holds the trial's result; also accept one directly under jobDir.
	const isTrialDir = (d: string) =>
		/__/.test(d.split("/").pop() ?? "") && existsSync(join(d, "result.json"));
	const subdirs = (d: string) =>
		readdirSync(d)
			.map((x) => join(d, x))
			.filter((x) => statSync(x).isDirectory());
	const trialDir = [
		...subdirs(jobDir),
		...subdirs(jobDir).flatMap(subdirs),
	].find(isTrialDir);
	if (!trialDir) return undefined;
	const result = JSON.parse(
		readFileSync(join(trialDir, "result.json"), "utf8"),
	) as HarborResult;
	const manifest = join(trialDir, "artifacts", "manifest.json");
	if (existsSync(manifest)) {
		const entries = JSON.parse(readFileSync(manifest, "utf8")) as {
			source?: string;
			status?: string;
		}[];
		const app = entries.find(
			(e) => e.source === "/app" || e.source === "/app/",
		);
		if (app) result.appReachedGrader = app.status === "ok";
	}
	let lastCallFailed: string | null = null;
	const transport = join(jobDir, "transport.log");
	if (existsSync(transport)) {
		const failures = readFileSync(transport, "utf8")
			.split("\n")
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as Record<string, unknown>];
				} catch {
					return [];
				}
			})
			.filter(
				(e) =>
					((e.phase === "stream-error" ||
						(e.phase === "stream" && e.terminal === "none")) &&
						!e.willRetry) ||
					e.phase === "request",
			);
		result.unrecoveredTransportFailure = failures.length
			? JSON.stringify(failures.at(-1))
			: null;
		// The agent's last model call failed (throttling or a provider error
		// outlasted the guard's waits): nothing after it succeeded, so the
		// provider, not the agent, ended the run.
		lastCallFailed = lastModelCallFailed(readFileSync(transport, "utf8"));
		if (lastCallFailed) result.unrecoveredTransportFailure = lastCallFailed;
	}
	const trialLog = join(trialDir, "trial.log");
	if (existsSync(trialLog)) {
		const text = readFileSync(trialLog, "utf8");
		result.harnessStoppedOnModelFailure =
			!!lastCallFailed ||
			[
				"The model request failed without a usable provider reason",
				"The agent stopped without a complete final result",
			].some((m) => text.includes(m));
	}
	const gpu = join(jobDir, "gpu-assert.txt");
	if (existsSync(gpu))
		result.gpuAsserted = /NVIDIA H100/.test(readFileSync(gpu, "utf8"));
	const killed = join(jobDir, "host-killed");
	if (existsSync(killed)) result.hostKilled = true;
	result.evidence = trialEvidence(trialDir);
	return result;
}

/** The bridge log and the verifier's test report of one trial dir (<task>__<id>). */
export function trialEvidence(trialDir: string) {
	const bridgeLog = join(trialDir, "agent", "ytimesy-bridge.log");
	const evidence = existsSync(bridgeLog)
		? bridgeLogEvidence(readFileSync(bridgeLog, "utf8"))
		: { bridgeLog: false, providerFailures: 0 };
	const ctrf = join(trialDir, "verifier", "ctrf.json");
	if (existsSync(ctrf))
		try {
			const failed = ctrfFailures(JSON.parse(readFileSync(ctrf, "utf8")));
			if (failed) return { ...evidence, failedTests: failed };
		} catch {
			// An unreadable report adds no evidence.
		}
	return evidence;
}

/**
 * Reads observe()'s probe output (unit state, host boot time, trial result path):
 * the trial is ready to collect only when its unit has ended and a trial-level
 * result exists.
 */
export function readProbe(lines: string[], launchedAt: string) {
	const unitActive =
		lines[0]?.trim() === "active" || lines[0]?.trim() === "activating";
	return {
		unitActive,
		ready: !unitActive && !!lines[2]?.trim(),
		rebootedSinceLaunch: Number(lines[1]) * 1000 > Date.parse(launchedAt),
	};
}

export function sshHostOps(runDir: string): HostOps {
	return {
		launch(host, attemptId, task) {
			// systemd-run on the host: the trial survives an ssh drop or a controller restart.
			ssh(
				host,
				`sudo systemd-run --unit=tb4-trial-${safeId(attemptId)} --property=Restart=no /opt/tb4/run-trial.sh ${safeId(task)} ${safeId(attemptId)}`,
			);
		},
		observe(host, attemptId, launchedAt) {
			const local = readTrialDir(join(runDir, "results", attemptId));
			if (local)
				return {
					result: local,
					processAlive: false,
					hostReachable: true,
					hostRebootedSinceLaunch: false,
				};
			try {
				const out = ssh(
					host,
					`systemctl is-active tb4-trial-${safeId(attemptId)} || true; date -d "$(uptime -s)" +%s; ls /opt/tb4/jobs/${safeId(attemptId)}/*/*__*/result.json 2>/dev/null | head -1`,
				).split("\n");
				const bootedAt = Number(out[1]) * 1000;
				// Collect only once the trial's unit has ended: Harbor writes result files
				// before the trial finishes.
				if (readProbe(out, launchedAt).ready) {
					this.collect(host, attemptId);
					return {
						result: readTrialDir(join(runDir, "results", attemptId)),
						processAlive: false,
						hostReachable: true,
						hostRebootedSinceLaunch: false,
					};
				}
				return {
					processAlive:
						out[0].trim() === "active" || out[0].trim() === "activating",
					hostReachable: true,
					hostRebootedSinceLaunch: bootedAt > Date.parse(launchedAt),
				};
			} catch {
				return {
					processAlive: false,
					hostReachable: false,
					hostRebootedSinceLaunch: false,
				};
			}
		},
		collect(host, attemptId) {
			const dest = join(runDir, "results", attemptId);
			sh("mkdir", ["-p", dest]);
			sh(
				"rsync",
				[
					"-a",
					"-e",
					"ssh -o BatchMode=yes",
					`${host.address}:/opt/tb4/jobs/${safeId(attemptId)}/`,
					`${dest}/`,
				],
				30 * 60_000,
			);
			const copies = [`controller:${dest}`];
			// Second copy off the machine (R2, S3-compatible). The bucket and keys live in /opt/tb4/backup.env.
			try {
				sh("/opt/tb4/backup.sh", [attemptId], 30 * 60_000);
				copies.push(`r2:results/${attemptId}`);
			} catch {
				// The watchdog's backup timer retries every 5 min; the trial is not lost.
			}
			return copies;
		},
		cleanup(host, attemptId) {
			// Harbor names a trial's compose project after its trial dir (<task>__<id>, lowercased).
			return ssh(
				host,
				`for d in /opt/tb4/jobs/${safeId(attemptId)}/*/*__*/; do [ -d "$d" ] || continue; p=$(basename "$d" | tr A-Z a-z); ids=$(docker ps -aq --filter "name=^\${p}__"); [ -n "$ids" ] && docker rm -f $ids >/dev/null && echo "removed containers of $p"; nets=$(docker network ls -q --filter "name=^\${p}"); [ -n "$nets" ] && docker network rm $nets >/dev/null 2>&1; done; true`,
			).trim();
		},
		health(host) {
			try {
				const out = ssh(
					host,
					"docker info --format '{{.NCPU}}' && nproc && df --output=avail -BG /opt/tb4 | tail -1",
					20_000,
				).split("\n");
				const ncpu = Number(out[0]);
				const nproc = Number(out[1]);
				const freeGb = Number(out[2]?.replace(/\D/g, ""));
				if (ncpu !== nproc)
					return {
						ok: false,
						why: `docker NCPU ${ncpu} != nproc ${nproc} (restart docker)`,
					};
				if (freeGb < 100) return { ok: false, why: `${freeGb} GB free` };
				return { ok: true, why: `${ncpu} vCPU, ${freeGb} GB free` };
			} catch {
				return { ok: false, why: "ssh/docker unreachable" };
			}
		},
	};
}

/** A hosts.json entry as provision.py / gpu-capacity.py write it. */
type FleetHost = Host & {
	type?: string;
	launchedAt?: number | string;
	stoppedAt?: number | string;
	market?: HostMarket;
};

/**
 * The GPU lane's ops. `daytona`: trials run on a runner host (`TB4_GPU_RUNNER`)
 * under systemd-run with Harbor's Daytona environment (host/run-gpu-trial.sh);
 * sandboxes are listed and deleted by host/daytona/daytona-ctl.py there (the key
 * stays on that host, 0600). `docker`: trials run on the AWS GPU host itself with
 * run-trial.sh (Harbor's docker environment), exactly as CPU trials do.
 */
export function gpuLaneOps(
	runDir: string,
	target: GpuTarget,
	host: Host,
): GpuLaneOps {
	const hostOps = sshHostOps(runDir);
	const base = {
		target,
		observe: (attemptId: string, launchedAt: string) =>
			hostOps.observe(host, attemptId, launchedAt),
		collect: (attemptId: string) => hostOps.collect(host, attemptId),
	};
	if (target.kind === "docker")
		return {
			...base,
			launch: (attemptId, task) => hostOps.launch(host, attemptId, task),
			cleanup: (attemptId) => hostOps.cleanup?.(host, attemptId) ?? "",
			sandboxLog: () => [],
			liveSandboxes() {
				// The GPU is free when no trial unit runs on the host (one trial at a time).
				try {
					const units = ssh(
						host,
						"systemctl list-units 'tb4-trial-*' --state=active,activating --no-legend --plain | awk '{print $1}'",
						30_000,
					)
						.split("\n")
						.map((l) => l.trim())
						.filter(Boolean);
					return {
						ok: true,
						sandboxes: units.map((u) => ({
							id: u,
							state: "active",
							gpus: 1,
							cpus: 0,
							memoryGiB: 0,
							storageGiB: 0,
							lane: false,
						})),
					};
				} catch (error) {
					return { ok: false, why: String(error).slice(0, 160) };
				}
			},
			deleteSandboxes: () => "",
		};
	const ctl = (args: string) =>
		ssh(
			host,
			`sudo -u ubuntu /opt/tb4/hd/bin/python -I /opt/tb4/daytona/daytona-ctl.py ${args}`,
			180_000,
		);
	return {
		...base,
		launch(attemptId, task) {
			ssh(
				host,
				`sudo systemd-run --unit=tb4-trial-${safeId(attemptId)} --property=Restart=no /opt/tb4/run-gpu-trial.sh ${safeId(task)} ${safeId(attemptId)}`,
			);
		},
		sandboxLog(attemptId) {
			const local = join(
				runDir,
				"results",
				attemptId,
				"daytona-sandboxes.jsonl",
			);
			try {
				const text = existsSync(local)
					? readFileSync(local, "utf8")
					: ssh(
							host,
							`cat /opt/tb4/jobs/${safeId(attemptId)}/daytona-sandboxes.jsonl 2>/dev/null || true`,
						);
				return text.split("\n").filter((l) => l.trim());
			} catch {
				return [];
			}
		},
		liveSandboxes() {
			try {
				return {
					ok: true,
					sandboxes: JSON.parse(ctl("list")) as LiveSandbox[],
				};
			} catch (error) {
				return { ok: false, why: String(error).slice(0, 160) };
			}
		},
		deleteSandboxes(ids) {
			return ctl(`delete ${ids.map(safeId).join(" ")}`).trim();
		},
	};
}

/** Hourly price of a hosts.json GPU host (its `type` and `market`, default on-demand). */
export function gpuHostHourly(
	h: FleetHost,
	env: Record<string, string | undefined> = process.env,
) {
	return awsGpuHostHourly(
		h.type ?? "p5.4xlarge",
		h.market ?? ((env.TB4_GPU_HOST_MARKET as HostMarket) || "on-demand"),
		env,
	);
}

/** Uptime of every GPU host in hosts.json: billed per host-hour, trials or not. */
export function gpuHostBilling(
	hosts: FleetHost[],
	now: string,
	env: Record<string, string | undefined> = process.env,
): BillingInterval[] {
	return hostIntervals(
		hosts
			.filter((h) => h.kind === "gpu")
			.map((h) => ({
				name: h.name,
				launchedAt: h.launchedAt,
				stoppedAt: h.stoppedAt,
				hourlyUsd: gpuHostHourly(h, env),
			})),
		now,
	);
}

/**
 * The GPU lane from the environment (undefined when TB4_GPU_LANE is unset):
 * `daytona` needs TB4_GPU_RUNNER, `docker` needs TB4_GPU_HOST (a kind "gpu" host).
 */
export function gpuLaneFromEnv(
	runDir: string,
	hosts: FleetHost[],
	env: Record<string, string | undefined> = process.env,
) {
	const kind = env.TB4_GPU_LANE;
	if (!kind) return undefined;
	let target: GpuTarget;
	let host: FleetHost | undefined;
	if (kind === "daytona") {
		host = hosts.find((h) => h.name === env.TB4_GPU_RUNNER);
		if (!host)
			throw new Error(
				`TB4_GPU_LANE=daytona needs TB4_GPU_RUNNER=<a hosts.json name>; got ${env.TB4_GPU_RUNNER ?? "unset"}`,
			);
		target = { kind: "daytona" };
	} else if (kind === "docker") {
		host = hosts.find((h) => h.name === env.TB4_GPU_HOST && h.kind === "gpu");
		if (!host)
			throw new Error(
				`TB4_GPU_LANE=docker needs TB4_GPU_HOST=<a kind "gpu" hosts.json name>; got ${env.TB4_GPU_HOST ?? "unset"}`,
			);
		target = {
			kind: "docker",
			host: host.name,
			hourlyUsd: gpuHostHourly(host, env),
		};
	} else throw new Error(`TB4_GPU_LANE must be daytona or docker; got ${kind}`);
	return {
		ops: gpuLaneOps(runDir, target, host),
		lane: new Journal<LaneEvent>(join(runDir, GPU_LANE_JOURNAL)),
		config: laneConfig(env, reviewConfig(env).stage1),
		budget: () => readBudget(runDir, env),
		hostBilling: (now: string) => gpuHostBilling(hosts, now, env),
	};
}

export function tick(input: {
	runDir: string;
	journal: Journal;
	hosts: Host[];
	tasks: Task[];
	ops: HostOps;
	now?: () => string;
	/** Review gate, error spike and stage-1 settings; default from TB4_* env (reviewConfig). */
	review?: ReviewConfig;
	/** The GPU lane (TB4_GPU_LANE): its tasks leave CPU scheduling and stage 1. */
	gpuLane?: {
		ops: GpuLaneOps;
		lane: Journal<LaneEvent>;
		config: LaneConfig;
		budget: () => ReturnType<typeof readBudget>;
		hostBilling?: (now: string) => BillingInterval[];
	};
}) {
	const now = input.now ?? (() => new Date().toISOString());
	const { journal, ops } = input;
	const review = input.review ?? reviewConfig(process.env);
	const hostByName = new Map(input.hosts.map((h) => [h.name, h]));
	let state = replay(journal.events());
	const log: string[] = [];
	const exclude = [
		...(process.env.TB4_EXCLUDE_TASKS?.split(",")
			.map((t) => t.trim())
			.filter(Boolean) ?? []),
		...(input.gpuLane?.config.order ?? []),
	];
	// Every finish carries its cause; a cause that is not benign holds new
	// launches until the operator acks it (the trial still scores as classified).
	const finish = (
		attemptId: string,
		task: string,
		outcome: TrialOutcome,
		result?: HarborResult,
	) => {
		const held = finishAttempt({
			journal,
			review,
			at: now(),
			attemptId,
			task,
			outcome,
			result,
		});
		if (held) log.push(held);
		return !!held;
	};
	// 1. Reconcile every unfinished attempt (this is also the restart path).
	for (const a of state.attempts.values()) {
		if (a.status === "finished") continue;
		// GPU-lane attempts are reconciled by the lane (gpuLaneTick), even when it is off.
		if (isLaneHost(a.host)) continue;
		const host = hostByName.get(a.host);
		if (!host) {
			finish(a.attemptId, a.task, {
				kind: "infra",
				reason: `host ${a.host} no longer in the fleet`,
			});
			continue;
		}
		const obs = ops.observe(host, a.attemptId, a.launchedAt);
		const r = reconcile(a, obs);
		if (r.action === "collect") {
			const copies = ops.collect(host, a.attemptId);
			finish(a.attemptId, a.task, r.outcome, obs.result);
			journal.append({
				at: now(),
				type: "synced",
				attemptId: a.attemptId,
				copies,
			});
			log.push(`finish ${a.attemptId} ${r.outcome.kind}`);
		} else if (r.action === "mark-infra") {
			finish(a.attemptId, a.task, { kind: "infra", reason: r.reason });
			log.push(`infra ${a.attemptId}: ${r.reason}`);
			try {
				const removed = ops.cleanup?.(host, a.attemptId);
				if (removed)
					log.push(`cleanup ${a.attemptId}: ${removed.replaceAll("\n", "; ")}`);
			} catch (error) {
				log.push(
					`cleanup ${a.attemptId} failed: ${String(error).slice(0, 160)}`,
				);
			}
		} else if (r.action === "adopt" && a.status === "launched") {
			journal.append({ at: now(), type: "running", attemptId: a.attemptId });
		}
	}
	// 1b. The pre-committed early-stop gates (TB4_EARLY_STOP=on; decisive set =
	// TB4_PRIORITY_TASKS; Codex per-task rates from TB4_CODEX_JOB). Logged every tick.
	state = replay(journal.events());
	if (process.env.TB4_EARLY_STOP === "on" && !state.stopped && state.runId) {
		const decisive = (process.env.TB4_PRIORITY_TASKS ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const codex = JSON.parse(
			readFileSync(
				process.env.TB4_CODEX_JOB ??
					"benchmarks/evaluation/codex-astra-public-job.json",
				"utf8",
			),
		) as {
			tasks: Record<string, { passes: number; trials: number }>;
		};
		const codexRates = new Map(
			Object.entries(codex.tasks).map(([t, v]) => [t, v.passes / v.trials]),
		);
		const cpuTasks = input.tasks.filter((t) => t.gpus === 0).map((t) => t.name);
		const g = earlyStopGates({ state, decisive, cpuTasks, codexRates });
		log.push(
			`gates: A ${g.gateA.status} (${g.gateA.passes} passes in ${g.gateA.ready}/${g.gateA.of} decisive first trials); B ceiling ${g.gateB.ceilingPct.toFixed(1)}% vs Codex ${g.gateB.codexPct.toFixed(1)}% on ${cpuTasks.length} CPU tasks${g.gateB.stop ? " -> stop" : ""}`,
		);
		if (g.gateA.status === "pass")
			journal.append({
				at: now(),
				type: "gate",
				gate: "A",
				result: "pass",
				detail: `${g.gateA.passes}/${g.gateA.ready} decisive first-trial passes >= 6`,
			});
		const reason =
			g.gateA.status === "stop"
				? `early-stop gate A: ${g.gateA.passes}/${g.gateA.ready} decisive first-trial passes <= 5`
				: g.gateB.stop
					? `early-stop gate B: ceiling ${g.gateB.ceilingPct.toFixed(1)}% < Codex ${g.gateB.codexPct.toFixed(1)}% on the ${cpuTasks.length} CPU tasks`
					: null;
		if (reason) {
			journal.append({
				at: now(),
				type: "gate",
				gate: g.gateA.status === "stop" ? "A" : "B",
				result: "stop",
				detail: reason,
			});
			journal.append({ at: now(), type: "stop", reason });
			log.push(
				`STOP ${reason}: no new launches; in-flight trials finish and are collected`,
			);
		}
	}
	// 1c. Error spike: several abnormal ends in a short window stop the run.
	state = replay(journal.events());
	const spike = state.stopped
		? null
		: errorSpike(state, Date.parse(now()), review);
	if (spike) {
		journal.append({ at: now(), type: "stop", reason: spike });
		log.push(
			`STOP ${spike}: no new launches; in-flight trials finish and are collected`,
		);
	}
	// 1d. Staged scaling: once every task's batch-1 trial is done, the rest waits for `ack stage1`.
	state = replay(journal.events());
	if (
		review.stage1 &&
		state.runId &&
		state.openBatches.has("b2") &&
		!state.stage1Released &&
		!state.stageReviewed &&
		stage1Complete(state, input.tasks, exclude)
	) {
		const b1 = [...state.attempts.values()].filter(
			(a) => a.batch === "b1" && a.status === "finished",
		);
		const passes = b1.filter(
			(a) => a.outcome?.kind === "valid" && a.outcome.reward >= 1,
		).length;
		const detail = `stage 1 done: ${passes} of ${b1.length} batch-1 attempts passed; read \`controller.ts failures\`, then \`controller.ts ack stage1 --note ...\``;
		journal.append({ at: now(), type: "stage-review", detail });
		log.push(`STAGE-REVIEW ${detail}`);
	}
	// 2. Launch what the plan still needs on healthy hosts.
	state = replay(journal.events());
	for (const [key, r] of state.reviews)
		log.push(`held: review ${key} (${r.cause}) not acked`);
	const unhealthy = new Set<string>();
	for (const h of input.hosts) {
		const health = ops.health(h);
		if (!health.ok) {
			unhealthy.add(h.name);
			log.push(`unhealthy ${h.name}: ${health.why}`);
		}
	}
	for (const d of nextLaunches({
		state,
		tasks: input.tasks,
		hosts: input.hosts,
		unhealthyHosts: unhealthy,
		maxInFlight: Number(process.env.TB4_MAX_IN_FLIGHT) || undefined,
		priority: process.env.TB4_PRIORITY_TASKS?.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
		exclude,
		stage1: review.stage1,
		frontload: process.env.TB4_FRONTLOAD_TASKS?.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
	})) {
		// Journal first: if the controller dies between these two lines, the restart
		// finds the attempt, sees no unit on the host and marks it infra (never started).
		journal.append({
			at: now(),
			type: "launch",
			attemptId: d.attemptId,
			task: d.task,
			batch: d.batch,
			host: d.host,
		});
		try {
			ops.launch(hostByName.get(d.host)!, d.attemptId, d.task);
			log.push(`launch ${d.attemptId} on ${d.host}`);
		} catch (error) {
			const held = finish(d.attemptId, d.task, {
				kind: "infra",
				reason: `launch failed: ${String(error).slice(0, 160)}`,
			});
			if (held) break;
		}
	}
	// 3. The GPU lane: one GPU trial at a time, budget permitting.
	if (input.gpuLane)
		for (const line of gpuLaneTick({
			journal,
			lane: input.gpuLane.lane,
			tasks: input.tasks,
			ops: input.gpuLane.ops,
			budget: input.gpuLane.budget(),
			hostBilling: input.gpuLane.hostBilling?.(now()),
			config: input.gpuLane.config,
			review,
			now,
		}))
			log.push(line);
	return log;
}

/**
 * Every non-pass (infra, or a valid reward below 1) with its cause, ordered by
 * finish time. A trial journaled before causes existed gets one derived from
 * its collected results dir, marked "derived".
 */
export function failureDigest(runDir: string, state: RunState) {
	const ackNote = new Map<string, string>();
	for (const a of state.acks) ackNote.set(a.key, a.note);
	return [...state.attempts.values()]
		.filter(
			(a) =>
				a.status === "finished" &&
				a.outcome &&
				(a.outcome.kind === "infra" || a.outcome.reward < 1),
		)
		.sort((x, y) => (x.finishedAt ?? "").localeCompare(y.finishedAt ?? ""))
		.map((a) => {
			const outcome = a.outcome!;
			let cause = a.cause;
			let derived = false;
			if (!cause) {
				const result = readTrialDir(join(runDir, "results", a.attemptId));
				cause = failureCause(outcome, result) ?? undefined;
				derived = true;
			}
			return {
				finishedAt: a.finishedAt ?? "",
				attemptId: a.attemptId,
				task: a.task,
				outcome: outcome.kind === "infra" ? "infra" : `valid ${outcome.reward}`,
				cause: cause?.cause ?? "unknown",
				detail: cause?.detail ?? "",
				...(cause?.failedTests ? { failedTests: cause.failedTests } : {}),
				derived,
				review: state.reviews.has(a.attemptId)
					? "pending"
					: ackNote.has(a.attemptId)
						? `acked: ${ackNote.get(a.attemptId)}`
						: "",
			};
		});
}

export function scoreReport(
	runDir: string,
	tasks: Task[],
	codexPath: string,
	reasonPath?: string,
) {
	const state = replay(new Journal(join(runDir, "journal.jsonl")).events());
	const perTask = scoredTrials(state);
	const names = tasks.map((t) => t.name).sort();
	const ours = passAt1(perTask, names);
	const codex = JSON.parse(readFileSync(codexPath, "utf8")) as {
		tasks: Record<string, { passes: number; trials: number }>;
	};
	const theirs = names.map((t) =>
		codex.tasks[t] ? codex.tasks[t].passes / codex.tasks[t].trials : 0,
	);
	const cmp = pairedComparison(ours.rates, theirs);
	const codexPct = (100 * theirs.reduce((a, b) => a + b, 0)) / names.length;
	const bounds = floorCeiling(perTask, names);
	const reason = reasonPath
		? (JSON.parse(readFileSync(reasonPath, "utf8")) as {
				tasks: Record<string, { passes: number; trials: number }>;
			})
		: undefined;
	const reasonRates = reason
		? names.map((t) =>
				reason.tasks[t] ? reason.tasks[t].passes / reason.tasks[t].trials : 0,
			)
		: undefined;
	const reasonPct = reasonRates
		? (100 * reasonRates.reduce((a, b) => a + b, 0)) / names.length
		: undefined;
	const infra = [...state.attempts.values()].filter(
		(a) => a.outcome?.kind === "infra",
	);
	const incomplete = names.filter(
		(t) =>
			(perTask.get(t)?.scored.length ?? 0) <
			(state.openBatches.has("b2") ? 5 : 1),
	);
	return {
		runId: state.runId,
		commit: state.commit,
		bundleSha256: state.bundleSha256,
		batches: [...state.openBatches],
		passAt1Pct: ours.pct,
		codexPassAt1Pct: codexPct,
		paired: cmp,
		bounds,
		vsCodex: earlyStopDecision(bounds, codexPct),
		...(reasonRates && reasonPct !== undefined
			? {
					reasonPassAt1Pct: reasonPct,
					pairedVsReason: pairedComparison(ours.rates, reasonRates),
					vsReason: earlyStopDecision(bounds, reasonPct),
				}
			: {}),
		batch2: state.openBatches.has("b2") ? "opened" : batch2Decision(cmp),
		infraAttempts: infra.map((a) => ({
			attemptId: a.attemptId,
			reason: (a.outcome as { reason: string }).reason,
		})),
		extraValidNotScored: [...perTask.entries()].flatMap(([t, v]) =>
			v.extra.map((e) => `${t}:${e.attemptId}`),
		),
		incompleteTasks: incomplete,
		perTask: Object.fromEntries(
			names.map((t, i) => [
				t,
				{
					scored: perTask.get(t)?.scored.length ?? 0,
					rate: ours.rates[i],
					codex: theirs[i],
				},
			]),
		),
	};
}

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			"run-dir": { type: "string", default: "/opt/tb4/run" },
			"run-id": { type: "string" },
			commit: { type: "string" },
			"bundle-sha256": { type: "string" },
			owner: { type: "string" },
			override: { type: "string" },
			codex: {
				type: "string",
				default: "benchmarks/evaluation/codex-public-job.json",
			},
			dataset: { type: "string" },
			"open-all": { type: "boolean", default: false },
			"reason-job": { type: "string" },
			note: { type: "string" },
			json: { type: "boolean", default: false },
		},
	});
	const runDir = values["run-dir"]!;
	const journal = new Journal(join(runDir, "journal.jsonl"));
	const hosts = () =>
		JSON.parse(readFileSync(join(runDir, "hosts.json"), "utf8")) as Host[];
	const tasks = () =>
		JSON.parse(readFileSync(join(runDir, "tasks.json"), "utf8")) as Task[];
	const at = () => new Date().toISOString();
	const [cmd, arg] = positionals;
	switch (cmd) {
		case "init": {
			if (replay(journal.events()).runId)
				throw new Error("run already initialised; the journal is append-only");
			if (
				!values["run-id"] ||
				!values.commit ||
				!/^[0-9a-f]{64}$/.test(values["bundle-sha256"] ?? "")
			)
				throw new Error(
					"--run-id, --commit and --bundle-sha256 (64 hex) are required",
				);
			journal.append({
				at: at(),
				type: "run-start",
				runId: values["run-id"],
				commit: values.commit,
				bundleSha256: values["bundle-sha256"]!,
			});
			journal.append({ at: at(), type: "batch-open", batch: "b1" });
			// The Astra x5 rule (docs/tb4-astra-run-2026-10-27.md): no batch-2 gate;
			// all 5 trials per task start together.
			if (values["open-all"])
				journal.append({ at: at(), type: "batch-open", batch: "b2" });
			break;
		}
		case "tasks": {
			const list = loadTasks(values.dataset ?? HARBOR_TASK_CACHE);
			writeFileSync(
				join(runDir, "tasks.json"),
				`${JSON.stringify(list, null, 2)}\n`,
			);
			console.log(
				`${list.length} tasks written to ${join(runDir, "tasks.json")}`,
			);
			break;
		}
		case "tick":
			for (const line of tick({
				runDir,
				journal,
				hosts: hosts(),
				tasks: tasks(),
				ops: sshHostOps(runDir),
				gpuLane: gpuLaneFromEnv(runDir, hosts()),
			}))
				console.log(line);
			break;
		case "loop":
			for (;;) {
				try {
					for (const line of tick({
						runDir,
						journal,
						hosts: hosts(),
						tasks: tasks(),
						ops: sshHostOps(runDir),
						gpuLane: gpuLaneFromEnv(runDir, hosts()),
					}))
						console.log(`${at()} ${line}`);
				} catch (error) {
					console.error(`${at()} tick failed: ${String(error).slice(0, 300)}`);
				}
				writeFileSync(join(runDir, "controller.heartbeat"), at());
				await new Promise((r) => setTimeout(r, 30_000));
			}
		case "open-batch": {
			if (arg !== "b2") throw new Error("only b2 can be opened");
			if (!values.owner)
				throw new Error("--owner <name> required (one owner per run)");
			const report = scoreReport(runDir, tasks(), values.codex!);
			const b1Done = report.incompleteTasks.length === 0;
			const decision =
				typeof report.batch2 === "string"
					? { go: true, why: "already open" }
					: report.batch2;
			if (!values.override && !(b1Done && decision.go))
				throw new Error(
					`batch 2 not opened: ${b1Done ? decision.why : `${report.incompleteTasks.length} tasks lack a batch-1 trial`}`,
				);
			journal.append({ at: at(), type: "batch-open", batch: "b2" });
			console.log(
				`b2 opened by ${values.owner}: ${values.override ? `override (${values.override})` : decision.why}`,
			);
			break;
		}
		case "pause":
			journal.append({ at: at(), type: "pause", reason: arg ?? "operator" });
			break;
		case "ack": {
			const s = replay(journal.events());
			const note = values.note?.trim();
			if (!arg || !note)
				throw new Error(
					'usage: ack <attemptId|stage1|all> --note "<what you read and why launches may resume>"',
				);
			if (
				arg === "all"
					? !s.reviews.size
					: !s.reviews.has(arg) && arg !== "stage1"
			)
				throw new Error(
					`nothing to ack for ${arg}; pending: ${[...s.reviews.keys()].join(", ") || "none"}`,
				);
			if (arg === "stage1" && s.stage1Released)
				throw new Error("stage 1 is already released");
			journal.append({
				at: at(),
				type: "ack",
				key: arg,
				note: sanitizeLine(note, 500),
			});
			const left = replay(journal.events()).reviews;
			console.log(
				`acked ${arg}; ${left.size ? `still pending: ${[...left.keys()].join(", ")}` : "launches resume on the next tick"}`,
			);
			break;
		}
		case "failures": {
			const rows = failureDigest(runDir, replay(journal.events()));
			if (values.json) console.log(JSON.stringify(rows, null, 2));
			else
				for (const r of rows)
					console.log(
						[
							r.finishedAt,
							r.attemptId,
							r.outcome,
							`${r.cause}${r.derived ? " (derived)" : ""}`,
							r.detail,
							r.review ? `[${r.review}]` : "",
						]
							.filter(Boolean)
							.join("  "),
					);
			const counts = new Map<string, number>();
			for (const r of rows) {
				const k = causeKind({ cause: r.cause });
				counts.set(k, (counts.get(k) ?? 0) + 1);
			}
			if (!values.json)
				console.log(
					`${rows.length} non-pass: ${[...counts].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
				);
			break;
		}
		case "resume":
			journal.append({ at: at(), type: "resume" });
			break;
		case "stop":
			journal.append({ at: at(), type: "stop", reason: arg ?? "operator" });
			break;
		case "status": {
			const s = replay(journal.events());
			const all = [...s.attempts.values()];
			console.log(
				JSON.stringify(
					{
						runId: s.runId,
						paused: s.paused,
						stopped: s.stopped,
						reviewsPending: Object.fromEntries(
							[...s.reviews].map(([k, r]) => [k, `${r.cause}: ${r.detail}`]),
						),
						stage1: s.stage1Released
							? "released"
							: s.stageReviewed
								? "awaiting ack stage1"
								: "running",
						batches: [...s.openBatches],
						inFlight: all.filter((a) => a.status !== "finished").length,
						valid: all.filter((a) => a.outcome?.kind === "valid").length,
						infra: all.filter((a) => a.outcome?.kind === "infra").length,
						target:
							BATCHES.filter((b) => s.openBatches.has(b.id)).reduce(
								(n, b) => n + b.trialsPerTask,
								0,
							) * tasks().length,
					},
					null,
					2,
				),
			);
			break;
		}
		case "gpu-status": {
			const lane = gpuLaneFromEnv(runDir, hosts());
			console.log(
				JSON.stringify(
					laneStatus({
						state: replay(journal.events()),
						tasks: tasks(),
						events: new Journal<LaneEvent>(
							join(runDir, GPU_LANE_JOURNAL),
						).events(),
						budget: readBudget(runDir),
						config:
							lane?.config ??
							laneConfig(process.env, reviewConfig(process.env).stage1),
						target: lane?.ops.target,
						hostBilling: gpuHostBilling(hosts(), at()),
					}),
					null,
					2,
				),
			);
			break;
		}
		case "gpu-budget": {
			// The lane's total GPU budget (all providers), from its first trial; re-read every tick.
			const usd = Number(arg);
			if (!arg || !Number.isFinite(usd) || usd < 0)
				throw new Error("usage: gpu-budget <total GPU budget in USD>");
			console.log(JSON.stringify(writeBudget(runDir, { budgetUsd: usd })));
			break;
		}
		case "gpu-spent": {
			// The actual GPU spend so far (Daytona billing + the GPU hosts' cost) replaces the estimate up to now.
			const usd = Number(arg);
			if (!arg || !Number.isFinite(usd) || usd < 0)
				throw new Error("usage: gpu-spent <actual GPU spend in USD>");
			console.log(
				JSON.stringify(
					writeBudget(runDir, { actualSpentUsd: usd, actualAt: at() }),
				),
			);
			break;
		}
		case "gpu-costs": {
			// Worst case (task.toml limits) and typical (Codex's public mean trial time), per target.
			const cfg = laneConfig(process.env, true);
			const codexPath = values.codex ?? "";
			const codex = existsSync(codexPath)
				? (JSON.parse(readFileSync(codexPath, "utf8")) as {
						tasks: Record<string, { meanSeconds?: number }>;
					})
				: { tasks: {} as Record<string, { meanSeconds?: number }> };
			const list = values.dataset ? loadTasks(values.dataset) : tasks();
			const r2 = (x: number) => Math.round(x * 100) / 100;
			const p5 = gpuHostHourly({
				name: "p5",
				kind: "gpu",
				vcpu: 16,
				memoryMb: 0,
				address: "",
			});
			for (const t of list) {
				if (!t.gpuSpec) continue;
				const w = worstCaseUsd(t.gpuSpec, cfg.overheadSec);
				const hw = hostWorstCaseUsd(t.gpuSpec, p5, cfg.overheadSec);
				const mean = codex.tasks[t.name]?.meanSeconds;
				console.log(
					JSON.stringify({
						task: t.name,
						daytona: {
							worstCaseUsd: r2(w.usd),
							worstHours: r2(w.hours),
							...(mean
								? {
										typicalUsd: r2(
											typicalUsd(t.gpuSpec, mean, cfg.overheadSec),
										),
									}
								: {}),
						},
						awsP5: {
							hourlyUsd: p5,
							worstCaseUsd: r2(hw.usd),
							worstHours: r2(hw.hours),
							...(mean
								? {
										typicalUsd: r2(
											hostTypicalUsd(t.gpuSpec, mean, p5, cfg.overheadSec),
										),
									}
								: {}),
						},
						...(mean
							? { typicalBasis: `Codex public mean ${mean}s per trial` }
							: {}),
					}),
				);
			}
			break;
		}
		case "score":
			console.log(
				JSON.stringify(
					scoreReport(runDir, tasks(), values.codex!, values["reason-job"]),
					null,
					2,
				),
			);
			break;
		default:
			throw new Error(`unknown command ${cmd}`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
