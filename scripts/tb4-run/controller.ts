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
 *     score [--codex benchmarks/evaluation/codex-public-job.json] [--reason-job <reason-job.json>]
 *     init ... --open-all            Astra x5 rule: both batches open at init, no batch-2 gate
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
	BATCHES,
	batch2Decision,
	earlyStopDecision,
	earlyStopGates,
	floorCeiling,
	type HarborResult,
	type Host,
	type HostObservation,
	Journal,
	lastModelCallFailed,
	nextLaunches,
	pairedComparison,
	passAt1,
	reconcile,
	replay,
	scoredTrials,
	type Task,
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
	const isTrialDir = (d: string) => /__/.test(d.split("/").pop() ?? "") && existsSync(join(d, "result.json"));
	const subdirs = (d: string) =>
		readdirSync(d)
			.map((x) => join(d, x))
			.filter((x) => statSync(x).isDirectory());
	const trialDir = [...subdirs(jobDir), ...subdirs(jobDir).flatMap(subdirs)].find(isTrialDir);
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
	return result;
}

/**
 * Reads observe()'s probe output (unit state, host boot time, trial result path):
 * the trial is ready to collect only when its unit has ended and a trial-level
 * result exists.
 */
export function readProbe(lines: string[], launchedAt: string) {
	const unitActive = lines[0]?.trim() === "active" || lines[0]?.trim() === "activating";
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

export function tick(input: {
	runDir: string;
	journal: Journal;
	hosts: Host[];
	tasks: Task[];
	ops: HostOps;
	now?: () => string;
}) {
	const now = input.now ?? (() => new Date().toISOString());
	const { journal, ops } = input;
	const hostByName = new Map(input.hosts.map((h) => [h.name, h]));
	let state = replay(journal.events());
	const log: string[] = [];
	// 1. Reconcile every unfinished attempt (this is also the restart path).
	for (const a of state.attempts.values()) {
		if (a.status === "finished") continue;
		const host = hostByName.get(a.host);
		if (!host) {
			journal.append({
				at: now(),
				type: "finish",
				attemptId: a.attemptId,
				outcome: {
					kind: "infra",
					reason: `host ${a.host} no longer in the fleet`,
				},
			});
			continue;
		}
		const r = reconcile(a, ops.observe(host, a.attemptId, a.launchedAt));
		if (r.action === "collect") {
			const copies = ops.collect(host, a.attemptId);
			journal.append({
				at: now(),
				type: "finish",
				attemptId: a.attemptId,
				outcome: r.outcome,
			});
			journal.append({
				at: now(),
				type: "synced",
				attemptId: a.attemptId,
				copies,
			});
			log.push(`finish ${a.attemptId} ${r.outcome.kind}`);
		} else if (r.action === "mark-infra") {
			journal.append({
				at: now(),
				type: "finish",
				attemptId: a.attemptId,
				outcome: { kind: "infra", reason: r.reason },
			});
			log.push(`infra ${a.attemptId}: ${r.reason}`);
			try {
				const removed = ops.cleanup?.(host, a.attemptId);
				if (removed) log.push(`cleanup ${a.attemptId}: ${removed.replaceAll("\n", "; ")}`);
			} catch (error) {
				log.push(`cleanup ${a.attemptId} failed: ${String(error).slice(0, 160)}`);
			}
		} else if (r.action === "adopt" && a.status === "launched") {
			journal.append({ at: now(), type: "running", attemptId: a.attemptId });
		}
	}
	// 1b. The pre-committed early-stop gates (TB4_EARLY_STOP=on; decisive set =
	// TB4_PRIORITY_TASKS; Codex per-task rates from TB4_CODEX_JOB). Logged every tick.
	state = replay(journal.events());
	if (process.env.TB4_EARLY_STOP === "on" && !state.stopped && state.runId) {
		const decisive = (process.env.TB4_PRIORITY_TASKS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
		const codex = JSON.parse(readFileSync(process.env.TB4_CODEX_JOB ?? "benchmarks/evaluation/codex-astra-public-job.json", "utf8")) as {
			tasks: Record<string, { passes: number; trials: number }>;
		};
		const codexRates = new Map(Object.entries(codex.tasks).map(([t, v]) => [t, v.passes / v.trials]));
		const cpuTasks = input.tasks.filter((t) => t.gpus === 0).map((t) => t.name);
		const g = earlyStopGates({ state, decisive, cpuTasks, codexRates });
		log.push(
			`gates: A ${g.gateA.status} (${g.gateA.passes} passes in ${g.gateA.ready}/${g.gateA.of} decisive first trials); B ceiling ${g.gateB.ceilingPct.toFixed(1)}% vs Codex ${g.gateB.codexPct.toFixed(1)}% on ${cpuTasks.length} CPU tasks${g.gateB.stop ? " -> stop" : ""}`,
		);
		if (g.gateA.status === "pass")
			journal.append({ at: now(), type: "gate", gate: "A", result: "pass", detail: `${g.gateA.passes}/${g.gateA.ready} decisive first-trial passes >= 6` });
		const reason =
			g.gateA.status === "stop"
				? `early-stop gate A: ${g.gateA.passes}/${g.gateA.ready} decisive first-trial passes <= 5`
				: g.gateB.stop
					? `early-stop gate B: ceiling ${g.gateB.ceilingPct.toFixed(1)}% < Codex ${g.gateB.codexPct.toFixed(1)}% on the ${cpuTasks.length} CPU tasks`
					: null;
		if (reason) {
			journal.append({ at: now(), type: "gate", gate: g.gateA.status === "stop" ? "A" : "B", result: "stop", detail: reason });
			journal.append({ at: now(), type: "stop", reason });
			log.push(`STOP ${reason}: no new launches; in-flight trials finish and are collected`);
		}
	}
	// 2. Launch what the plan still needs on healthy hosts.
	state = replay(journal.events());
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
			journal.append({
				at: now(),
				type: "finish",
				attemptId: d.attemptId,
				outcome: {
					kind: "infra",
					reason: `launch failed: ${String(error).slice(0, 160)}`,
				},
			});
		}
	}
	return log;
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
