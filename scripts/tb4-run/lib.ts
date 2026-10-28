/**
 * TB4 run controller core (docs/tb4-run-controller.md, docs/tb4-scoring-rule.md).
 * Pure functions plus an append-only journal, so the controller, the watchdog
 * and the scorer share one model of the run and the tests cover it offline.
 *
 * State lives in one JSON-lines journal on the controller's disk. Every event is
 * appended and fsynced before the action it describes, so a controller restart
 * replays the journal and resumes without duplicating or losing a trial.
 */
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
} from "node:fs";

/* ---------- plan ---------- */

export type HostKind = "cpu" | "gpu";
export type Host = {
	name: string;
	kind: HostKind;
	vcpu: number;
	memoryMb: number;
	/** ssh target, e.g. ubuntu@10.0.1.12 */
	address: string;
};
export type Task = {
	name: string;
	cpus: number;
	memoryMb: number;
	gpus: number;
	separateVerifier: boolean;
};
/**
 * A Task from a parsed task.toml. cpus and memory are the larger of the agent
 * environment and a separate verifier environment, since the verifier runs on
 * the same host after the agent.
 */
export function taskFromToml(
	name: string,
	toml: Record<string, unknown>,
): Task {
	const env = (toml.environment ?? {}) as Record<string, unknown>;
	const verifier = (toml.verifier ?? {}) as Record<string, unknown>;
	const venv = (verifier.environment ?? {}) as Record<string, unknown>;
	const separateVerifier =
		verifier.environment_mode === "separate" ||
		env.environment_mode === "separate";
	const num = (v: unknown) => Number(v ?? 0) || 0;
	return {
		name,
		cpus: Math.max(num(env.cpus) || 1, separateVerifier ? num(venv.cpus) : 0),
		memoryMb: Math.max(
			num(env.memory_mb),
			separateVerifier ? num(venv.memory_mb) : 0,
		),
		gpus: num(env.gpus),
		separateVerifier,
	};
}
export type Batch = { id: "b1" | "b2"; trialsPerTask: number };
export const BATCHES: Batch[] = [
	{ id: "b1", trialsPerTask: 1 },
	{ id: "b2", trialsPerTask: 4 },
];
export const SCORED_TRIALS_PER_TASK = 5;

/** Attempt caps per task per batch (scoring rule section 3). */
export function attemptCap(task: Task, batch: Batch) {
	const extra = task.gpus > 0 ? 4 : 3;
	return batch.trialsPerTask + extra;
}

/* ---------- journal ---------- */

export type TrialOutcome =
	| { kind: "valid"; reward: number; agentStartedAt: string; detail: string }
	| { kind: "infra"; reason: string };

export type JournalEvent =
	| {
			at: string;
			type: "run-start";
			runId: string;
			commit: string;
			bundleSha256: string;
	  }
	| { at: string; type: "batch-open"; batch: Batch["id"] }
	| {
			at: string;
			type: "launch";
			attemptId: string;
			task: string;
			batch: Batch["id"];
			host: string;
	  }
	| { at: string; type: "running"; attemptId: string; agentStartedAt?: string }
	| { at: string; type: "finish"; attemptId: string; outcome: TrialOutcome }
	| { at: string; type: "synced"; attemptId: string; copies: string[] }
	| { at: string; type: "pause"; reason: string }
	| { at: string; type: "resume" }
	| { at: string; type: "stop"; reason: string }
	/** The early-stop gates' decisions (docs/tb4-astra-run-2026-10-27.md): gate A passes once, for good. */
	| { at: string; type: "gate"; gate: "A" | "B"; result: "pass" | "stop"; detail: string };

export class Journal {
	constructor(readonly path: string) {}
	events(): JournalEvent[] {
		if (!existsSync(this.path)) return [];
		const out: JournalEvent[] = [];
		for (const line of readFileSync(this.path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as JournalEvent);
			} catch {
				// A torn last line (power loss mid-write) is ignored; every earlier
				// line was fsynced before its action ran.
			}
		}
		return out;
	}
	append(event: JournalEvent) {
		const fd = openSync(this.path, "a");
		try {
			appendFileSync(fd, `${JSON.stringify(event)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}

export type Attempt = {
	attemptId: string;
	task: string;
	batch: Batch["id"];
	host: string;
	launchedAt: string;
	status: "launched" | "running" | "finished";
	agentStartedAt?: string;
	outcome?: TrialOutcome;
	copies: string[];
};
export type RunState = {
	runId?: string;
	commit?: string;
	bundleSha256?: string;
	openBatches: Set<Batch["id"]>;
	attempts: Map<string, Attempt>;
	paused: string | null;
	stopped: string | null;
	/** Gate A passed (>= 6 decisive first-trial passes): it is never evaluated again. */
	gateAPassed: boolean;
};

export function replay(events: JournalEvent[]): RunState {
	const state: RunState = {
		openBatches: new Set(),
		attempts: new Map(),
		paused: null,
		stopped: null,
		gateAPassed: false,
	};
	for (const e of events) {
		switch (e.type) {
			case "run-start":
				state.runId = e.runId;
				state.commit = e.commit;
				state.bundleSha256 = e.bundleSha256;
				break;
			case "batch-open":
				state.openBatches.add(e.batch);
				break;
			case "launch":
				if (!state.attempts.has(e.attemptId))
					state.attempts.set(e.attemptId, {
						attemptId: e.attemptId,
						task: e.task,
						batch: e.batch,
						host: e.host,
						launchedAt: e.at,
						status: "launched",
						copies: [],
					});
				break;
			case "running": {
				const a = state.attempts.get(e.attemptId);
				if (a && a.status !== "finished") {
					a.status = "running";
					a.agentStartedAt = e.agentStartedAt ?? a.agentStartedAt;
				}
				break;
			}
			case "finish": {
				const a = state.attempts.get(e.attemptId);
				// First finish wins: a graded trial is never re-classified by a later event.
				if (a && a.status !== "finished") {
					a.status = "finished";
					a.outcome = e.outcome;
					if (e.outcome.kind === "valid")
						a.agentStartedAt = e.outcome.agentStartedAt;
				}
				break;
			}
			case "synced": {
				const a = state.attempts.get(e.attemptId);
				if (a) a.copies = [...new Set([...a.copies, ...e.copies])];
				break;
			}
			case "pause":
				state.paused = e.reason;
				break;
			case "resume":
				state.paused = null;
				break;
			case "stop":
				state.stopped = e.reason;
				break;
			case "gate":
				if (e.gate === "A" && e.result === "pass") state.gateAPassed = true;
				break;
		}
	}
	return state;
}

/** Deterministic, unique attempt ids: the Harbor job name on the host. */
export function attemptId(
	runId: string,
	task: string,
	batch: Batch["id"],
	n: number,
) {
	return `${runId}-${batch}-${task}-a${String(n).padStart(2, "0")}`;
}

/* ---------- scheduling ---------- */

export type TaskProgress = {
	valid: number;
	inFlight: number;
	attempts: number;
};
export function progress(
	state: RunState,
	task: string,
	batch: Batch["id"],
): TaskProgress {
	let valid = 0;
	let inFlight = 0;
	let attempts = 0;
	for (const a of state.attempts.values()) {
		if (a.task !== task || a.batch !== batch) continue;
		attempts++;
		if (a.status !== "finished") inFlight++;
		else if (a.outcome?.kind === "valid") valid++;
	}
	return { valid, inFlight, attempts };
}

export function hostLoad(
	state: RunState,
	tasks: Map<string, Task>,
	host: string,
) {
	let vcpu = 0;
	let memoryMb = 0;
	let gpus = 0;
	let trials = 0;
	for (const a of state.attempts.values()) {
		if (a.host !== host || a.status === "finished") continue;
		const t = tasks.get(a.task);
		if (!t) continue;
		// A separate verifier container runs after the agent on the same host;
		// `tasks` stores cpus as max(environment, verifier) so either phase fits.
		vcpu += trialCpuCost(t);
		memoryMb += t.memoryMb;
		gpus += t.gpus;
		trials++;
	}
	return { vcpu, memoryMb, gpus, trials };
}

/**
 * Per-host trial concurrency (docs/tb4-run-controller.md, "Host CPU budget").
 * Every in-flight trial keeps its full task.toml CPU allocation: the sum of the
 * in-flight tasks' `cpus` plus a per-trial overhead for the processes that run on
 * the host next to the container (Harbor CLI, our bridge and agent loop, docker
 * exec) must fit in the host's vCPU minus a fixed reserve (dockerd, sshd,
 * backup, watchdog). The one exception: an idle host always takes one trial, so a
 * task as large as its host (jax-speedrun-gpu: 16 cpus on the 16-vCPU p5) still
 * runs, alone.
 */
export const HOST_RESERVED_VCPU = 2;
export const TRIAL_OVERHEAD_VCPU = 1;
export function hostCpuBudget(host: Pick<Host, "vcpu">) {
	return host.vcpu - HOST_RESERVED_VCPU;
}
export function trialCpuCost(task: Pick<Task, "cpus">) {
	return task.cpus + TRIAL_OVERHEAD_VCPU;
}
/** Whether one more trial of `task` keeps every trial on `host` at full CPU. */
export function fitsCpu(
	host: Pick<Host, "vcpu">,
	load: { vcpu: number; trials: number },
	task: Pick<Task, "cpus">,
) {
	if (load.trials === 0) return true;
	return load.vcpu + trialCpuCost(task) <= hostCpuBudget(host);
}

export type LaunchDecision = {
	task: string;
	batch: Batch["id"];
	host: string;
	attemptId: string;
};

/**
 * The next trials to launch. A task never has more trials in flight than it
 * still needs valid ones, so no task over-runs its batch; attempt caps stop a
 * task that keeps failing as infra (it is reported, never scored as 0).
 */
export function nextLaunches(input: {
	state: RunState;
	tasks: Task[];
	hosts: Host[];
	unhealthyHosts?: Set<string>;
	/** Most trials in flight at once across the fleet (keeps model load under the provider's rate limits). */
	maxInFlight?: number;
	/** Tasks to launch first within each batch (after GPU tasks), in this order: the ones that decide the score. */
	priority?: readonly string[];
}): LaunchDecision[] {
	const { state } = input;
	if (state.paused || state.stopped || !state.runId) return [];
	const running = [...state.attempts.values()].filter(
		(a) => a.status !== "finished",
	).length;
	const room = () =>
		(input.maxInFlight ?? Number.POSITIVE_INFINITY) - running - out.length;
	const byName = new Map(input.tasks.map((t) => [t.name, t]));
	const out: LaunchDecision[] = [];
	const load = new Map(
		input.hosts.map((h) => [h.name, hostLoad(state, byName, h.name)]),
	);
	for (const batch of BATCHES) {
		if (!state.openBatches.has(batch.id)) continue;
		// GPU tasks first: they are the long pole; among them the largest
		// (jax-speedrun-gpu, ~7.6 h) first, so the short GPU tasks fill in after.
		const rank = (name: string) => {
			const i = input.priority?.indexOf(name) ?? -1;
			return i < 0 ? Number.POSITIVE_INFINITY : i;
		};
		const ordered = [...input.tasks].sort(
			(a, b) =>
				b.gpus - a.gpus ||
				(a.gpus > 0 ? b.cpus - a.cpus : 0) ||
				(rank(a.name) === rank(b.name)
					? 0
					: rank(a.name) < rank(b.name)
						? -1
						: 1),
		);
		for (const task of ordered) {
			const p = progress(state, task.name, batch.id);
			const pending = out.filter(
				(d) => d.task === task.name && d.batch === batch.id,
			).length;
			let need = batch.trialsPerTask - p.valid - p.inFlight - pending;
			let attempts = p.attempts + pending;
			while (need > 0 && attempts < attemptCap(task, batch) && room() > 0) {
				const host = input.hosts.find((h) => {
					if (input.unhealthyHosts?.has(h.name)) return false;
					if (task.gpus > 0 !== (h.kind === "gpu")) return false;
					const l = load.get(h.name)!;
					const gpuFree = h.kind === "gpu" ? l.gpus + task.gpus <= 1 : true;
					return (
						gpuFree &&
						fitsCpu(h, l, task) &&
						l.memoryMb + task.memoryMb <= h.memoryMb * 0.9
					);
				});
				if (!host) break;
				const l = load.get(host.name)!;
				l.vcpu += trialCpuCost(task);
				l.trials++;
				l.memoryMb += task.memoryMb;
				l.gpus += task.gpus;
				attempts++;
				out.push({
					task: task.name,
					batch: batch.id,
					host: host.name,
					attemptId: attemptId(state.runId, task.name, batch.id, attempts),
				});
				need--;
			}
		}
	}
	return out;
}

/** On restart: what to do with each attempt the journal shows unfinished. */
export type HostObservation = {
	/** result.json found in the job dir on the host or controller. */
	result?: HarborResult;
	/** The Harbor process (systemd unit tb4-trial@<attemptId>) is still active. */
	processAlive: boolean;
	/** The host answered (ssh ok). */
	hostReachable: boolean;
	/** Host boot time is after the launch (it rebooted). */
	hostRebootedSinceLaunch: boolean;
};
export type Reconcile =
	| { action: "adopt" }
	| { action: "collect"; outcome: TrialOutcome }
	| { action: "mark-infra"; reason: string }
	| { action: "wait" };

export function reconcile(attempt: Attempt, obs: HostObservation): Reconcile {
	if (obs.result) return { action: "collect", outcome: classify(obs.result) };
	if (!obs.hostReachable) return { action: "wait" };
	if (obs.hostRebootedSinceLaunch)
		return { action: "mark-infra", reason: "host restarted during the trial" };
	if (obs.processAlive) return { action: "adopt" };
	return {
		action: "mark-infra",
		reason: `harbor process gone without result.json (was ${attempt.status})`,
	};
}

/**
 * The last model call in a trial's transport log, as JSON, when it failed:
 * an error response handed back (throttling or 5xx past the guard's waits),
 * a request error, or a stream cut with no resend. null when it succeeded.
 */
export function lastModelCallFailed(log: string): string | null {
	const entries = log.split("\n").flatMap((line) => {
		try {
			return [JSON.parse(line) as Record<string, unknown>];
		} catch {
			return [];
		}
	});
	const last = entries
		.filter((e) => e.phase !== "throttle" || e.willRetry === false)
		.at(-1);
	if (!last) return null;
	const failed =
		(last.phase === "throttle" && last.willRetry === false) ||
		last.phase === "response" ||
		last.phase === "request" ||
		((last.phase === "stream-error" ||
			last.phase === "stream-cut" ||
			last.phase === "degenerate") &&
			!last.willRetry);
	return failed ? JSON.stringify(last) : null;
}

/* ---------- classification (port of rerun classify.py, scoring rule 2) ---------- */

export type HarborResult = {
	trial_name?: string;
	agent_execution?: {
		started_at?: string | null;
		finished_at?: string | null;
	} | null;
	verifier_result?: { rewards?: { reward?: number | null } | null } | null;
	exception_info?: {
		exception_type?: string;
		exception_message?: string;
	} | null;
	/** Added by the collector from artifacts/manifest.json. */
	appReachedGrader?: boolean;
	/** Added by the collector from the trial's transport log. */
	unrecoveredTransportFailure?: string | null;
	/** Added by the collector: the harness stopped on a model-request failure. */
	harnessStoppedOnModelFailure?: boolean;
	/** Added by the collector: GPU model asserted inside the trial (GPU tasks). */
	gpuAsserted?: boolean | null;
	/** Added by the collector: the host was terminated or rebooted by AWS. */
	hostKilled?: boolean;
};

export function classify(r: HarborResult): TrialOutcome {
	const started = r.agent_execution?.started_at;
	if (!started) return { kind: "infra", reason: "agent never started" };
	if (r.hostKilled)
		return { kind: "infra", reason: "host killed by the provider" };
	if (r.gpuAsserted === false)
		return {
			kind: "infra",
			reason: "GPU model not asserted as H100 inside the trial (void)",
		};
	const reward = r.verifier_result?.rewards?.reward;
	if (reward === null || reward === undefined)
		return {
			kind: "infra",
			reason: `no reward (${r.exception_info?.exception_type ?? "grader produced none"})`,
		};
	if (r.appReachedGrader === false)
		return { kind: "infra", reason: "agent /app did not reach the grader" };
	if (r.harnessStoppedOnModelFailure && r.unrecoveredTransportFailure)
		return {
			kind: "infra",
			reason: `model transport failure ended the agent: ${r.unrecoveredTransportFailure.slice(0, 200)}`,
		};
	// Wrong answer, gave up, agent time limit, a model refusing: always valid.
	return {
		kind: "valid",
		reward,
		agentStartedAt: started,
		detail: `reward ${reward}`,
	};
}

/* ---------- scoring ---------- */

export type ScoredTrial = {
	attemptId: string;
	batch: Batch["id"];
	reward: number;
	agentStartedAt: string;
};

/**
 * Scoring rule 4: batch 1's first valid trial by agent start, then batch 2's
 * first four by agent start; extras are disclosed, never scored.
 */
export function scoredTrials(state: RunState) {
	const perTask = new Map<
		string,
		{ scored: ScoredTrial[]; extra: ScoredTrial[] }
	>();
	const valid = [...state.attempts.values()]
		.filter((a) => a.outcome?.kind === "valid")
		.map((a) => ({
			task: a.task,
			attemptId: a.attemptId,
			batch: a.batch,
			reward: (a.outcome as { reward: number }).reward,
			agentStartedAt: (a.outcome as { agentStartedAt: string }).agentStartedAt,
		}))
		.sort((a, b) => a.agentStartedAt.localeCompare(b.agentStartedAt));
	for (const t of valid) {
		const entry = perTask.get(t.task) ?? { scored: [], extra: [] };
		perTask.set(t.task, entry);
		const quota = BATCHES.find((b) => b.id === t.batch)!.trialsPerTask;
		const inBatch = entry.scored.filter((s) => s.batch === t.batch).length;
		const { task: _task, ...trial } = t;
		(inBatch < quota ? entry.scored : entry.extra).push(trial);
	}
	return perTask;
}

/** pass@1 = mean over tasks of (passes / scored trials), reward >= 1 is a pass. */
export function passAt1(
	perTask: Map<string, { scored: ScoredTrial[] }>,
	tasks: string[],
) {
	const rates = tasks.map((t) => {
		const s = perTask.get(t)?.scored ?? [];
		return s.length ? s.filter((x) => x.reward >= 1).length / s.length : 0;
	});
	return {
		pct: (100 * rates.reduce((a, b) => a + b, 0)) / tasks.length,
		rates,
	};
}

/** Unbiased pass@k per task (Chen et al. 2021): 1 - C(n-c, k)/C(n, k). */
export function passAtK(n: number, c: number, k: number) {
	if (n - c < k) return 1;
	let prod = 1;
	for (let i = n - c + 1; i <= n; i++) prod *= 1 - k / i;
	return 1 - prod;
}

/** Paired comparison over tasks with a seeded bootstrap 95% interval. */
export function pairedComparison(
	ours: number[],
	theirs: number[],
	seed = 20261021,
	draws = 10000,
) {
	if (ours.length !== theirs.length)
		throw new Error("paired arrays differ in length");
	const d = ours.map((o, i) => o - theirs[i]);
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
	let s = seed >>> 0;
	const rand = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const boots: number[] = [];
	for (let b = 0; b < draws; b++) {
		let sum = 0;
		for (let i = 0; i < d.length; i++) sum += d[Math.floor(rand() * d.length)];
		boots.push(sum / d.length);
	}
	boots.sort((a, b) => a - b);
	return {
		meanDiffPts: 100 * mean(d),
		ci95Pts: [
			100 * boots[Math.floor(0.025 * draws)],
			100 * boots[Math.floor(0.975 * draws)],
		] as [number, number],
		tasksBetter: d.filter((x) => x > 0).length,
		tasksWorse: d.filter((x) => x < 0).length,
		tasksTied: d.filter((x) => x === 0).length,
	};
}

/**
 * Live bounds on the final pass@1 while trials are running: the floor counts
 * every missing trial as a fail, the ceiling as a pass. Once the floor is
 * above a competitor's score no remaining trial can change the order; once
 * the ceiling is below it, we cannot catch up.
 */
export function floorCeiling(
	perTask: Map<string, { scored: ScoredTrial[] }>,
	tasks: string[],
	trialsPerTask = SCORED_TRIALS_PER_TASK,
) {
	let floor = 0;
	let ceiling = 0;
	let missing = 0;
	for (const t of tasks) {
		const s = (perTask.get(t)?.scored ?? []).slice(0, trialsPerTask);
		const passes = s.filter((x) => x.reward >= 1).length;
		const left = trialsPerTask - s.length;
		missing += left;
		floor += passes / trialsPerTask;
		ceiling += (passes + left) / trialsPerTask;
	}
	return {
		floorPct: (100 * floor) / tasks.length,
		ceilingPct: (100 * ceiling) / tasks.length,
		missingTrials: missing,
	};
}

/** The Astra run's only early stop: the ceiling is below the competitor. */
export function earlyStopDecision(
	bounds: ReturnType<typeof floorCeiling>,
	competitorPct: number,
) {
	if (bounds.ceilingPct < competitorPct)
		return {
			stop: true,
			why: `ceiling ${bounds.ceilingPct.toFixed(1)}% < ${competitorPct.toFixed(1)}%: cannot catch up`,
		};
	if (bounds.floorPct > competitorPct)
		return {
			stop: false,
			why: `floor ${bounds.floorPct.toFixed(1)}% > ${competitorPct.toFixed(1)}%: ahead whatever remains; finish the run`,
		};
	return {
		stop: false,
		why: `undecided: ${bounds.floorPct.toFixed(1)}%..${bounds.ceilingPct.toFixed(1)}% vs ${competitorPct.toFixed(1)}%`,
	};
}

/**
 * The Astra run's pre-committed early stop (docs/tb4-astra-run-2026-10-27.md).
 * Gate A: once the first scored trial (earliest agent start among the task's
 * valid scored trials; infra attempts never count) exists for at least
 * `gateAMinTasks` of the decisive tasks, our passes among those first trials
 * <= `gateAMaxPasses` stops the run; more passes pass gate A for good.
 * Gate B (any time): the ceiling over the CPU tasks (every missing scored
 * trial counted as a pass) below Codex's pass@1 on the same tasks stops it.
 */
export const EARLY_STOP = { gateAMinTasks: 15, gateAMaxPasses: 5 };
export function earlyStopGates(input: {
	state: RunState;
	decisive: string[];
	cpuTasks: string[];
	codexRates: Map<string, number>;
	trialsPerTask?: number;
}) {
	const perTask = scoredTrials(input.state);
	const firsts = input.decisive
		.map((t) => perTask.get(t)?.scored[0])
		.filter((x): x is ScoredTrial => !!x);
	const passes = firsts.filter((x) => x.reward >= 1).length;
	const gateA = input.state.gateAPassed
		? { status: "passed" as const, passes, ready: firsts.length, of: input.decisive.length }
		: firsts.length < EARLY_STOP.gateAMinTasks
			? { status: "pending" as const, passes, ready: firsts.length, of: input.decisive.length }
			: {
					status: passes <= EARLY_STOP.gateAMaxPasses ? ("stop" as const) : ("pass" as const),
					passes,
					ready: firsts.length,
					of: input.decisive.length,
				};
	const bounds = floorCeiling(perTask, input.cpuTasks, input.trialsPerTask);
	const codexPct =
		(100 * input.cpuTasks.reduce((a, t) => a + (input.codexRates.get(t) ?? 0), 0)) / input.cpuTasks.length;
	const gateB = { stop: bounds.ceilingPct < codexPct, ceilingPct: bounds.ceilingPct, floorPct: bounds.floorPct, codexPct };
	return { gateA, gateB };
}

/** Scoring rule 5: batch 2 runs only when batch 1 is clearly ahead. */
export function batch2Decision(cmp: ReturnType<typeof pairedComparison>) {
	return cmp.meanDiffPts >= 3
		? {
				go: true,
				why: `batch 1 is ${cmp.meanDiffPts.toFixed(1)} pts ahead (>= 3)`,
			}
		: {
				go: false,
				why: `batch 1 is ${cmp.meanDiffPts.toFixed(1)} pts vs Codex (< 3): stop, report batch 1`,
			};
}

/* ---------- spend ---------- */

const envUsd = (name: string, fallback: number) =>
	Number(process.env[name] ?? "") || fallback;
export const SPEND = {
	/** Expected model spend for 330 trials on Bedrock (Sol lead + Luna roles). */
	modelExpectedUsd: [360, 500] as const,
	/** Expected infra (EC2 hosts + p5 + EBS + egress). */
	infraExpectedUsd: [300, envUsd("TB4_INFRA_CAP_USD", 560)] as const,
	/** Bridge per-trial cap: ~8x the expected mean ($1.1-1.5), below the bridge max $100. */
	trialCapUsd: envUsd("TB4_TRIAL_CAP_USD", 12),
	/** Bridge total cap per host ledger and the controller's global model stop. */
	modelTotalCapUsd: envUsd("TB4_MODEL_TOTAL_CAP_USD", 900),
	/**
	 * Launches stop this much below the total cap, so trials already running
	 * can finish without the settled total passing the cap (0 = stop at the cap).
	 */
	modelStopMarginUsd: envUsd("TB4_MODEL_STOP_MARGIN_USD", 0),
	/** AWS Budget (monthly, account-wide: EC2 + Bedrock + Marketplace). */
	awsBudgetUsd: envUsd("TB4_AWS_BUDGET_USD", 1500),
	alertFractions: [0.5, 0.8, 1] as const,
};

export type LedgerLine = {
	type?: string;
	usd?: number;
	costUsd?: number;
	trial?: string;
};
/** Settled spend plus open reservations from a bridge ledger (JSON lines). */
export function ledgerTotals(lines: LedgerLine[]) {
	let settled = 0;
	const open = new Map<string, number>();
	for (const l of lines) {
		const amount = Number(l.usd ?? l.costUsd ?? 0);
		const key = l.trial ?? "";
		if (l.type === "reserve") open.set(key, amount);
		else if (l.type === "settle") {
			settled += amount;
			open.delete(key);
		}
	}
	return { settled, reserved: [...open.values()].reduce((a, b) => a + b, 0) };
}

export function crossedThresholds(
	spent: number,
	cap: number,
	alreadyAlerted: number[],
) {
	return SPEND.alertFractions.filter(
		(f) => spent >= f * cap && !alreadyAlerted.includes(f),
	);
}

/* ---------- watchdog ---------- */

export type WatchInput = {
	now: number;
	state: RunState;
	/** Per in-flight attempt: ms since its log last grew. */
	logSilenceMs: Map<string, number>;
	unhealthyHosts: string[];
	bedrockErrorsLast15m: { throttles: number; serverErrors: number };
	modelSpendUsd: number;
	infraSpendUsd: number;
	alerted: { model: number[]; infra: number[] };
	controllerActive: boolean;
	lastProgressAt: number;
};
export type Alert = {
	level: "info" | "warn" | "critical";
	key: string;
	text: string;
};

export function watch(input: WatchInput): {
	alerts: Alert[];
	actions: string[];
} {
	const alerts: Alert[] = [];
	const actions: string[] = [];
	if (!input.controllerActive) {
		alerts.push({
			level: "critical",
			key: "controller-down",
			text: "tb4-controller.service not active; restarting it",
		});
		actions.push("restart-controller");
	}
	for (const [id, ms] of input.logSilenceMs)
		if (ms >= 20 * 60_000)
			alerts.push({
				level: "warn",
				key: `silent:${id}`,
				text: `${id}: no log output for ${Math.round(ms / 60_000)} min`,
			});
	for (const h of input.unhealthyHosts)
		alerts.push({
			level: "critical",
			key: `host:${h}`,
			text: `host ${h} unhealthy (ssh/docker/disk); no new trials go there`,
		});
	const { throttles, serverErrors } = input.bedrockErrorsLast15m;
	if (throttles >= 20) {
		alerts.push({
			level: "warn",
			key: "bedrock-throttle",
			text: `Bedrock throttled ${throttles}x in 15 min; pausing new launches`,
		});
		actions.push("pause:bedrock-throttle");
	}
	if (serverErrors >= 10)
		alerts.push({
			level: "warn",
			key: "bedrock-5xx",
			text: `Bedrock 5xx ${serverErrors}x in 15 min`,
		});
	for (const f of crossedThresholds(
		input.modelSpendUsd,
		SPEND.modelTotalCapUsd,
		input.alerted.model,
	)) {
		alerts.push({
			level: f >= 1 ? "critical" : "warn",
			key: `model-spend-${f}`,
			text: `model spend $${input.modelSpendUsd.toFixed(0)} crossed ${f * 100}% of $${SPEND.modelTotalCapUsd}`,
		});
		if (f >= 1) actions.push("stop:model-cap");
	}
	const stopAt = SPEND.modelTotalCapUsd - SPEND.modelStopMarginUsd;
	if (
		SPEND.modelStopMarginUsd > 0 &&
		input.modelSpendUsd >= stopAt &&
		input.modelSpendUsd < SPEND.modelTotalCapUsd
	) {
		alerts.push({
			level: "critical",
			key: "model-spend-margin",
			text: `model spend $${input.modelSpendUsd.toFixed(0)} reached the stop line $${stopAt.toFixed(0)} (cap $${SPEND.modelTotalCapUsd} minus margin for running trials)`,
		});
		actions.push("stop:model-cap");
	}
	const infraCap = SPEND.infraExpectedUsd[1];
	for (const f of crossedThresholds(
		input.infraSpendUsd,
		infraCap,
		input.alerted.infra,
	)) {
		alerts.push({
			level: f >= 1 ? "critical" : "warn",
			key: `infra-spend-${f}`,
			text: `infra spend ~$${input.infraSpendUsd.toFixed(0)} crossed ${f * 100}% of $${infraCap}`,
		});
		if (f >= 1) actions.push("pause:infra-cap");
	}
	const inFlight = [...input.state.attempts.values()].filter(
		(a) => a.status !== "finished",
	).length;
	if (inFlight > 0 && input.now - input.lastProgressAt >= 60 * 60_000)
		alerts.push({
			level: "warn",
			key: "no-progress",
			text: `no trial finished in ${Math.round((input.now - input.lastProgressAt) / 60_000)} min with ${inFlight} in flight`,
		});
	return { alerts, actions };
}

/** Rough infra spend: instance-hours x hourly price (confirm prices before the run). */
export const HOURLY_USD: Record<string, number> = {
	"t3.small": 0.0208,
	"m7i.16xlarge": 3.2256,
	// p5.4xlarge (1 H100): fill from the EC2 on-demand pricing page before the run.
	"p5.4xlarge": Number(process.env.TB4_P5_4XL_HOURLY_USD ?? 0) || 0,
};
export function infraSpend(
	instances: { type: string; launchedAt: number; stoppedAt?: number }[],
	now: number,
) {
	return instances.reduce(
		(sum, i) =>
			sum +
			((HOURLY_USD[i.type] ?? 0) * ((i.stoppedAt ?? now) - i.launchedAt)) /
				3_600_000,
		0,
	);
}
