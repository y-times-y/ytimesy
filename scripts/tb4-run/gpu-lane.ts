/**
 * TB4 GPU lane (docs/tb4-run-controller.md, "GPU lane"): the GPU tasks run strictly
 * one trial at a time, in a fixed task order (fp8-rmsnorm-gemm, math-eval-grader,
 * then jax-speedrun-gpu), on one target:
 *
 * - `daytona`: Harbor's Daytona environment from a runner host. The account allows one
 *   GPU at a time and each task needs an H100 for the agent and another for its
 *   separate verifier, so the next trial launches only when the account lists no GPU
 *   sandbox, and inside a trial the Harbor patch (host/daytona/sitecustomize.py) waits
 *   for the agent sandbox to be gone before the verifier sandbox is created.
 *   Billed per sandbox-second, in money (Daytona's free credits exclude GPUs).
 * - `docker`: an AWS GPU host (p5.4xlarge, 1 H100) running Harbor's docker
 *   environment like the CPU hosts (run-trial.sh); agent and verifier containers share
 *   the host's one GPU. Billed per host-hour while the host runs, from AWS credits.
 *
 * Before each launch the lane checks one GPU budget (all providers): the trial's
 * worst case (task.toml time limits on the target's prices) must fit in the budget
 * minus a buffer, counting what is already spent (sandbox lifetimes, GPU host uptime,
 * or an actual figure the operator recorded). Otherwise it journals `gpu-pause` and the
 * watchdog asks for more budget.
 *
 * Trials use the run's journal like the CPU lane (launch, finish + cause,
 * review-needed, synced; host "gpu-lane:<target>"), so scoring, `failures`, `ack` and
 * the review gate are unchanged. Billing detail lives in the lane's own journal,
 * <run-dir>/gpu-lane-journal.jsonl.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_SANDBOX_OVERHEAD_SEC,
	type GpuTaskSpec,
	hostWorstCaseUsd,
	hourlyUsd,
	type SandboxResources,
	worstCaseUsd,
} from "./gpu-cost.ts";
import {
	type Alert,
	attemptCap,
	BATCHES,
	type Batch,
	classify,
	finishAttempt,
	type HarborResult,
	type HostObservation,
	type Journal,
	attemptId as makeAttemptId,
	progress,
	type ReviewConfig,
	type RunState,
	reconcile,
	replay,
	sanitizeLine,
	type Task,
	type TrialOutcome,
} from "./lib.ts";

/** fp8 and math first (short), then jax (up to 8 h of agent time). */
export const GPU_LANE_ORDER = [
	"fp8-rmsnorm-gemm",
	"math-eval-grader",
	"jax-speedrun-gpu",
] as const;
export const GPU_LANE_JOURNAL = "gpu-lane-journal.jsonl";
export const GPU_BUDGET_FILE = "gpu-budget.json";
/** The label the Harbor patch puts on every lane sandbox (with ytimesy-attempt=<id>). */
export const LANE_LABEL = "tb4-gpu";
/** Every GPU-lane attempt's `host` in the run journal starts with this. */
export const LANE_HOST_PREFIX = "gpu-lane:";
export const isLaneHost = (host: string) => host.startsWith(LANE_HOST_PREFIX);

export type GpuTarget =
	| { kind: "daytona" }
	/** An AWS GPU host from hosts.json, billed per host-hour. */
	| { kind: "docker"; host: string; hourlyUsd: number };
export const laneHost = (t: GpuTarget) =>
	`${LANE_HOST_PREFIX}${t.kind === "daytona" ? "daytona" : t.host}`;

/* ---------- lane journal ---------- */

/** Something billed per hour over a time span: a Daytona sandbox or a GPU host's uptime. */
export type BillingInterval = {
	id: string;
	role: string;
	start: string;
	end: string;
	/** Still running: charged up to `end` (the attempt's finish or now). */
	open?: boolean;
	hourlyUsd: number;
	usd: number;
	/** Daytona sandboxes: the billed resources. */
	resources?: SandboxResources;
};
const intervalUsd = (hourly: number, start: string, end: string) =>
	Math.max(0, (hourly * (Date.parse(end) - Date.parse(start))) / 3_600_000);

export type LaneEvent =
	/** The budget or the actual figure the lane saw changed (gpu-budget.json or env). */
	| {
			at: string;
			type: "gpu-budget";
			budgetUsd: number | null;
			actualSpentUsd?: number;
			actualAt?: string;
			source: string;
	  }
	| {
			at: string;
			type: "gpu-launch";
			attemptId: string;
			task: string;
			target: string;
			worstCaseUsd: number;
			spentUsd: number;
			budgetUsd: number;
	  }
	/** The next trial does not fit the budget: nothing launches until it is raised. */
	| {
			at: string;
			type: "gpu-pause";
			attemptId: string;
			task: string;
			target: string;
			budgetUsd: number | null;
			spentUsd: number;
			worstCaseUsd: number;
			bufferUsd: number;
			needUsd: number;
			reason: string;
	  }
	| {
			at: string;
			type: "gpu-resume";
			attemptId: string;
			budgetUsd: number;
			spentUsd: number;
			worstCaseUsd: number;
	  }
	/**
	 * One finished attempt. basis "sandbox" (Daytona): its sandboxes, counted in the
	 * spend. basis "host": the GPU host's time during the trial, for the report only
	 * (the host's uptime is counted as a whole).
	 */
	| {
			at: string;
			type: "gpu-spend";
			attemptId: string;
			task: string;
			basis?: "sandbox" | "host";
			usd: number;
			sandboxes: BillingInterval[];
	  }
	/** Lane sandboxes found on Daytona with no trial running: deleted, and charged. */
	| {
			at: string;
			type: "gpu-orphans";
			ids: string[];
			usd: number;
			sandboxes: BillingInterval[];
	  }
	/** Something the lane did not start holds the GPU (a Daytona sandbox, a trial unit on the host). */
	| { at: string; type: "gpu-blocked"; ids: string[]; detail: string };

/* ---------- budget ---------- */

export type Budget = {
	/** Total GPU spend the lane may reach (all providers), counted from its first trial. */
	budgetUsd: number | null;
	/** The operator's actual GPU spend so far (billing pages) as of actualAt. */
	actualSpentUsd?: number;
	actualAt?: string;
	source: string;
	error?: string;
};

/** gpu-budget.json in the run dir (re-read every tick), else TB4_GPU_BUDGET_USD. */
export function readBudget(
	runDir: string,
	env: Record<string, string | undefined> = process.env,
): Budget {
	const fromEnv = () => {
		const v = env.TB4_GPU_BUDGET_USD;
		const n = v !== undefined && v.trim() !== "" ? Number(v) : Number.NaN;
		return Number.isFinite(n) ? n : null;
	};
	const path = join(runDir, GPU_BUDGET_FILE);
	if (!existsSync(path))
		return { budgetUsd: fromEnv(), source: "env TB4_GPU_BUDGET_USD" };
	try {
		const f = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const budget = Number(f.budgetUsd);
		const actual = Number(f.actualSpentUsd);
		return {
			budgetUsd:
				f.budgetUsd !== undefined && Number.isFinite(budget)
					? budget
					: fromEnv(),
			...(f.actualSpentUsd !== undefined && Number.isFinite(actual)
				? { actualSpentUsd: actual, actualAt: String(f.actualAt ?? "") }
				: {}),
			source: GPU_BUDGET_FILE,
		};
	} catch (error) {
		// An unreadable file never means "unlimited": no budget, so the lane pauses.
		return {
			budgetUsd: null,
			source: GPU_BUDGET_FILE,
			error: `unreadable ${GPU_BUDGET_FILE}: ${String(error).slice(0, 120)}`,
		};
	}
}

/** Writes gpu-budget.json atomically, keeping the fields not given. */
export function writeBudget(
	runDir: string,
	update: { budgetUsd?: number; actualSpentUsd?: number; actualAt?: string },
) {
	const path = join(runDir, GPU_BUDGET_FILE);
	let current: Record<string, unknown> = {};
	try {
		if (existsSync(path)) current = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		current = {};
	}
	const next = { ...current, ...update, updatedAt: new Date().toISOString() };
	writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
	return next;
}

/* ---------- spend ---------- */

type SandboxLine = {
	at?: string;
	event?: string;
	id?: string;
	role?: string;
	state?: string;
	gpu?: string;
	cpus?: number;
	memoryGiB?: number;
	storageGiB?: number;
	gpus?: number;
	detail?: string;
};
export function parseSandboxLog(lines: string[]): SandboxLine[] {
	return lines.flatMap((l) => {
		try {
			const e = JSON.parse(l);
			return e && typeof e === "object" ? [e as SandboxLine] : [];
		} catch {
			return [];
		}
	});
}

/**
 * Each Daytona sandbox's life from the patch's log: `create` starts it; `gone` (no
 * longer listed) ends it, else `delete` (deletion requested), else it is charged up
 * to `endAt` and marked open.
 */
export function sandboxIntervals(
	lines: string[],
	endAt: string,
): BillingInterval[] {
	const out = new Map<string, BillingInterval & { ended?: string }>();
	for (const e of parseSandboxLog(lines)) {
		if (!e.id || !e.at) continue;
		if (e.event === "create") {
			const resources = {
				cpus: Number(e.cpus) || 0,
				memoryGiB: Number(e.memoryGiB) || 0,
				storageGiB: Number(e.storageGiB) || 0,
				gpus: Number(e.gpus) || 0,
			};
			out.set(e.id, {
				id: e.id,
				role: e.role ?? "sandbox",
				start: e.at,
				end: endAt,
				open: true,
				hourlyUsd: hourlyUsd(resources),
				usd: 0,
				resources,
			});
			continue;
		}
		const s = out.get(e.id);
		if (!s) continue;
		if (e.event === "gone" || (e.event === "delete" && s.ended !== "gone")) {
			s.end = e.at;
			s.ended = e.event;
			delete s.open;
		}
	}
	return [...out.values()].map(({ ended: _ended, ...s }) => ({
		...s,
		usd: intervalUsd(s.hourlyUsd, s.start, s.end),
	}));
}

/** Sandboxes the lane journal counts as spend (Daytona attempts and deleted orphans). */
export function billedIntervals(events: LaneEvent[]): BillingInterval[] {
	return events.flatMap((e) =>
		(e.type === "gpu-spend" && (e.basis ?? "sandbox") === "sandbox") ||
		e.type === "gpu-orphans"
			? e.sandboxes
			: [],
	);
}

/**
 * GPU hosts' uptime, billed per host-hour whether or not a trial runs: from launch
 * to stop (or now).
 */
export function hostIntervals(
	hosts: {
		name: string;
		launchedAt?: number | string;
		stoppedAt?: number | string;
		hourlyUsd: number;
	}[],
	now: string,
): BillingInterval[] {
	const iso = (v: number | string) =>
		typeof v === "number" ? new Date(v).toISOString() : v;
	return hosts.flatMap((h) => {
		if (h.launchedAt === undefined) return [];
		const start = iso(h.launchedAt);
		const end = h.stoppedAt !== undefined ? iso(h.stoppedAt) : now;
		return [
			{
				id: h.name,
				role: "gpu-host",
				start,
				end,
				...(h.stoppedAt === undefined ? { open: true } : {}),
				hourlyUsd: h.hourlyUsd,
				usd: intervalUsd(h.hourlyUsd, start, end),
			},
		];
	});
}

/**
 * The lane's GPU spend so far, all providers: the operator's actual figure plus every
 * billed second after it, or (no actual figure) every billed second. `extra` adds GPU
 * host uptime and a running trial's sandboxes.
 */
export function spentEstimate(
	events: LaneEvent[],
	budget: Pick<Budget, "actualSpentUsd" | "actualAt">,
	extra: BillingInterval[] = [],
) {
	const all = [...billedIntervals(events), ...extra];
	const since =
		budget.actualSpentUsd !== undefined && budget.actualAt
			? Date.parse(budget.actualAt)
			: Number.NaN;
	if (!Number.isFinite(since)) return all.reduce((sum, s) => sum + s.usd, 0);
	return all.reduce((sum, s) => {
		const start = new Date(Math.max(Date.parse(s.start), since)).toISOString();
		return sum + intervalUsd(s.hourlyUsd, start, s.end);
	}, budget.actualSpentUsd ?? 0);
}

/**
 * The worst case of a task's next trial on the target. Daytona: the task.toml limits,
 * each sandbox's resources raised to what that task's sandboxes actually got (a
 * snapshot built bigger than the task.toml bills at the snapshot's size). Docker GPU
 * host: the host's hours for the agent and verifier limits.
 */
export function laneWorstCase(
	target: GpuTarget,
	task: string,
	spec: GpuTaskSpec,
	events: LaneEvent[],
	overheadSec: number,
) {
	if (target.kind === "docker")
		return hostWorstCaseUsd(spec, target.hourlyUsd, overheadSec).usd;
	const agent = { ...spec.agent };
	const verifier = spec.verifier && { ...spec.verifier };
	for (const e of events) {
		if (e.type !== "gpu-spend" || e.task !== task) continue;
		for (const s of e.sandboxes) {
			const into = s.role === "verifier" ? verifier : agent;
			if (!into || !s.resources) continue;
			into.cpus = Math.max(into.cpus, s.resources.cpus);
			into.memoryGiB = Math.max(into.memoryGiB, s.resources.memoryGiB);
			into.storageGiB = Math.max(into.storageGiB, s.resources.storageGiB);
			into.gpus = Math.max(into.gpus, s.resources.gpus);
		}
	}
	return worstCaseUsd({ ...spec, agent, verifier }, overheadSec).usd;
}

export function budgetGate(input: {
	budgetUsd: number | null;
	spentUsd: number;
	worstCaseUsd: number;
	bufferUsd: number;
}) {
	const needed = input.spentUsd + input.worstCaseUsd + input.bufferUsd;
	if (input.budgetUsd === null)
		return { ok: false, needUsd: needed, reason: "no GPU budget set" };
	const ok = needed <= input.budgetUsd;
	return {
		ok,
		needUsd: ok ? 0 : needed - input.budgetUsd,
		reason: ok
			? ""
			: `spent ~$${input.spentUsd.toFixed(2)} + worst case $${input.worstCaseUsd.toFixed(2)} + buffer $${input.bufferUsd.toFixed(2)} > budget $${input.budgetUsd.toFixed(2)}`,
	};
}

/* ---------- preemption and classification ---------- */

const LOST_RE =
	/preempt|evict|reclaim|sandbox\b[^.]{0,80}\b(is not running|not found|was (stopped|destroyed|deleted)|has been (stopped|destroyed|deleted))|DaytonaNotFoundError|Sandbox is not running/i;
const GPU_LIMIT_RE = /GPU limit|Total GPU|one-GPU guard/i;

/**
 * Why a Daytona trial is infra beyond classify(): the provider took a sandbox away
 * (the patch logs `lost` when a sandbox is not running at Harbor's stop; Harbor never
 * stops one on its own: auto-stop is off), the account's GPU was still held, or no
 * H100 was asserted inside the agent sandbox. null when none applies.
 */
export function daytonaInfraReason(
	result: HarborResult | undefined,
	sandboxLog: string[],
): string | null {
	const ev = parseSandboxLog(sandboxLog);
	const lost = ev.find((e) => e.event === "lost");
	if (lost)
		return `Daytona ${lost.role ?? "sandbox"} sandbox ${sanitizeLine(lost.state ?? "gone", 40)} before Harbor stopped it (preempted or killed by the provider)`;
	const text = result?.exception_info
		? `${result.exception_info.exception_type ?? ""}: ${result.exception_info.exception_message ?? ""}`
		: "";
	if (GPU_LIMIT_RE.test(text) || ev.some((e) => e.event === "gpu-wait-timeout"))
		return "Daytona GPU limit: another GPU sandbox was still live";
	if (LOST_RE.test(text))
		return `Daytona sandbox lost: ${sanitizeLine(text, 160)}`;
	if (result?.agent_execution?.started_at) {
		const asserted = ev.some(
			(e) =>
				e.event === "gpu-assert" &&
				e.role === "agent" &&
				/NVIDIA H100/.test(e.gpu ?? ""),
		);
		if (!asserted)
			return "no NVIDIA H100 asserted by nvidia-smi inside the agent sandbox (void)";
	}
	return null;
}

/** A trial's outcome on the lane's target (preemption and a missing H100 are infra). */
export function classifyGpuTrial(
	target: GpuTarget,
	result: HarborResult | undefined,
	sandboxLog: string[],
): TrialOutcome {
	if (target.kind === "daytona") {
		const reason = daytonaInfraReason(result, sandboxLog);
		if (reason) return { kind: "infra", reason };
	} else if (result?.agent_execution?.started_at && result.gpuAsserted !== true)
		// run-trial.sh writes the host's nvidia-smi to gpu-assert.txt before Harbor starts.
		return {
			kind: "infra",
			reason: "no NVIDIA H100 asserted by nvidia-smi on the GPU host (void)",
		};
	return result
		? classify(result)
		: { kind: "infra", reason: "no result.json" };
}

/* ---------- plan ---------- */

export type LaneConfig = {
	order: string[];
	bufferUsd: number;
	overheadSec: number;
	stage1: boolean;
};
export function laneConfig(
	env: Record<string, string | undefined>,
	stage1: boolean,
): LaneConfig {
	const list = env.TB4_GPU_LANE_TASKS?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	const n = (v: string | undefined, d: number) =>
		v !== undefined && v.trim() !== "" && Number.isFinite(Number(v))
			? Number(v)
			: d;
	return {
		order: list?.length ? list : [...GPU_LANE_ORDER],
		bufferUsd: n(env.TB4_GPU_BUFFER_USD, 5),
		overheadSec:
			n(env.TB4_GPU_OVERHEAD_MIN, DEFAULT_SANDBOX_OVERHEAD_SEC / 60) * 60,
		stage1,
	};
}

export type NextGpuTrial =
	| { kind: "launch"; task: Task; batch: Batch["id"]; attemptId: string }
	| { kind: "wait"; why: string }
	| { kind: "done" };

/**
 * The next GPU trial in strict task order: a task's trials (batch 1, then batch 2)
 * all run before the next task starts. A batch that is not open is skipped (it is not
 * part of the plan yet); an open batch 2 held by stage 1 makes the lane wait. A task
 * at its attempt cap is done (reported, never scored as 0).
 */
export function nextGpuTrial(
	state: RunState,
	tasks: Task[],
	cfg: LaneConfig,
): NextGpuTrial {
	const byName = new Map(tasks.map((t) => [t.name, t]));
	for (const name of cfg.order) {
		const task = byName.get(name);
		if (!task) continue;
		for (const batch of BATCHES) {
			if (!state.openBatches.has(batch.id)) continue;
			const p = progress(state, name, batch.id);
			if (batch.trialsPerTask - p.valid - p.inFlight <= 0) continue;
			if (p.attempts >= attemptCap(task, batch)) continue;
			if (batch.id !== "b1" && cfg.stage1 && !state.stage1Released)
				return {
					kind: "wait",
					why: `${name} batch 2 waits for \`controller.ts ack stage1\``,
				};
			return {
				kind: "launch",
				task,
				batch: batch.id,
				attemptId: makeAttemptId(
					state.runId ?? "",
					name,
					batch.id,
					p.attempts + 1,
				),
			};
		}
	}
	return { kind: "done" };
}

/* ---------- the lane's tick ---------- */

export type LiveSandbox = {
	id: string;
	state: string;
	gpus: number;
	cpus: number;
	memoryGiB: number;
	storageGiB: number;
	createdAt?: string;
	/** Carries the lane label (ytimesy-lane=tb4-gpu): the lane may delete it. */
	lane: boolean;
	attemptId?: string;
};

/** Everything that touches the target; replaced by a fake in tests. */
export type GpuLaneOps = {
	target: GpuTarget;
	/** Starts the trial (systemd-run on the runner or the GPU host). */
	launch(attemptId: string, task: string): void;
	observe(attemptId: string, launchedAt: string): HostObservation;
	collect(attemptId: string): string[];
	/** Removes a dead attempt's containers or sandboxes. */
	cleanup?(attemptId: string): string;
	/** Daytona: the trial's daytona-sandboxes.jsonl lines; docker: []. */
	sandboxLog(attemptId: string): string[];
	/**
	 * What holds the GPU now: Daytona's sandboxes (not destroyed), or the GPU host's
	 * active trial units (lane: false). Empty = free.
	 */
	liveSandboxes():
		| { ok: true; sandboxes: LiveSandbox[] }
		| { ok: false; why: string };
	deleteSandboxes(ids: string[]): string;
};

const GONE_STATES = /^(destroyed|archived)$/i;

/** Array.prototype.findLast (ES2023) for the ES2022 lib. */
function findLast<T, S extends T>(
	xs: readonly T[],
	pred: (x: T) => x is S,
): S | undefined {
	for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i])) return xs[i] as S;
	return undefined;
}
type GateEvent = Extract<
	LaneEvent,
	{ type: "gpu-pause" | "gpu-resume" | "gpu-launch" }
>;
const lastGateEvent = (events: LaneEvent[]) =>
	findLast(
		events,
		(e): e is GateEvent =>
			e.type === "gpu-pause" ||
			e.type === "gpu-resume" ||
			e.type === "gpu-launch",
	);
const r2 = (x: number) => Math.round(x * 100) / 100;

export function gpuLaneTick(input: {
	journal: Journal;
	lane: Journal<LaneEvent>;
	tasks: Task[];
	ops: GpuLaneOps;
	budget: Budget;
	/** GPU hosts' uptime (hostIntervals), counted in the spend. */
	hostBilling?: BillingInterval[];
	config: LaneConfig;
	review: ReviewConfig;
	now?: () => string;
}): string[] {
	const now = input.now ?? (() => new Date().toISOString());
	const { journal, lane, ops, budget, config } = input;
	const target = ops.target;
	const host = laneHost(target);
	const log: string[] = [];
	let laneEvents = lane.events();
	const appendLane = (e: LaneEvent) => {
		lane.append(e);
		laneEvents = [...laneEvents, e];
	};

	// 0. Audit every change of the budget or the actual figure.
	const lastBudget = findLast(
		laneEvents,
		(e): e is Extract<LaneEvent, { type: "gpu-budget" }> =>
			e.type === "gpu-budget",
	);
	if (
		!lastBudget ||
		lastBudget.budgetUsd !== budget.budgetUsd ||
		lastBudget.actualSpentUsd !== budget.actualSpentUsd ||
		lastBudget.actualAt !== budget.actualAt
	)
		appendLane({
			at: now(),
			type: "gpu-budget",
			budgetUsd: budget.budgetUsd,
			...(budget.actualSpentUsd !== undefined
				? { actualSpentUsd: budget.actualSpentUsd, actualAt: budget.actualAt }
				: {}),
			source: budget.source,
		});
	if (budget.error) log.push(`gpu: ${budget.error}`);

	// 1. Reconcile the lane's unfinished attempt (also the restart path). An attempt
	// journaled on another target (the lane was switched) is reconciled only by that
	// target's ops; it holds this one until it ends.
	let state = replay(journal.events());
	const record = (attemptId: string, task: string, launchedAt: string) => {
		if (target.kind === "docker") {
			const usd = intervalUsd(target.hourlyUsd, launchedAt, now());
			appendLane({
				at: now(),
				type: "gpu-spend",
				attemptId,
				task,
				basis: "host",
				usd,
				sandboxes: [
					{
						id: target.host,
						role: "gpu-host",
						start: launchedAt,
						end: now(),
						hourlyUsd: target.hourlyUsd,
						usd,
					},
				],
			});
			return usd;
		}
		const sandboxes = sandboxIntervals(ops.sandboxLog(attemptId), now());
		const usd = sandboxes.reduce((s, x) => s + x.usd, 0);
		appendLane({
			at: now(),
			type: "gpu-spend",
			attemptId,
			task,
			basis: "sandbox",
			usd,
			sandboxes,
		});
		return usd;
	};
	for (const a of state.attempts.values()) {
		if (a.host !== host || a.status === "finished") continue;
		const obs = ops.observe(a.attemptId, a.launchedAt);
		const r = reconcile(a, obs);
		if (r.action === "collect") {
			const copies = ops.collect(a.attemptId);
			const outcome = classifyGpuTrial(
				target,
				obs.result,
				ops.sandboxLog(a.attemptId),
			);
			const held = finishAttempt({
				journal,
				review: input.review,
				at: now(),
				attemptId: a.attemptId,
				task: a.task,
				outcome,
				result: obs.result,
			});
			if (held) log.push(held);
			journal.append({
				at: now(),
				type: "synced",
				attemptId: a.attemptId,
				copies,
			});
			const usd = record(a.attemptId, a.task, a.launchedAt);
			log.push(
				`gpu finish ${a.attemptId} ${outcome.kind}${outcome.kind === "infra" ? ` (${outcome.reason})` : ""}; ~$${usd.toFixed(2)} GPU`,
			);
		} else if (r.action === "mark-infra") {
			const held = finishAttempt({
				journal,
				review: input.review,
				at: now(),
				attemptId: a.attemptId,
				task: a.task,
				outcome: { kind: "infra", reason: r.reason },
			});
			if (held) log.push(held);
			const usd = record(a.attemptId, a.task, a.launchedAt);
			log.push(
				`gpu infra ${a.attemptId}: ${r.reason}; ~$${usd.toFixed(2)} GPU`,
			);
			try {
				const removed = ops.cleanup?.(a.attemptId);
				if (removed)
					log.push(
						`gpu cleanup ${a.attemptId}: ${removed.replaceAll("\n", "; ")}`,
					);
			} catch (error) {
				log.push(
					`gpu cleanup ${a.attemptId} failed: ${String(error).slice(0, 160)}`,
				);
			}
		} else if (r.action === "adopt" && a.status === "launched") {
			journal.append({ at: now(), type: "running", attemptId: a.attemptId });
		}
	}

	// 2. Strictly one trial at a time, on any target.
	state = replay(journal.events());
	const inFlight = [...state.attempts.values()].find(
		(a) => isLaneHost(a.host) && a.status !== "finished",
	);
	if (inFlight) {
		const running =
			inFlight.host === host && target.kind === "daytona"
				? sandboxIntervals(ops.sandboxLog(inFlight.attemptId), now())
				: [];
		log.push(
			`gpu: ${inFlight.attemptId} in flight on ${inFlight.host}${
				running.length
					? ` (${
							running
								.filter((s) => s.open)
								.map((s) => s.role)
								.join("+") || "no sandbox open"
						}; ~$${running.reduce((s, x) => s + x.usd, 0).toFixed(2)} so far)`
					: ""
			}`,
		);
		return log;
	}
	if (state.stopped || state.paused || !state.runId || state.reviews.size) {
		log.push(
			`gpu: held (${state.stopped ? `stopped: ${state.stopped}` : state.paused ? `paused: ${state.paused}` : !state.runId ? "no run" : `review pending: ${[...state.reviews.keys()].join(", ")}`})`,
		);
		return log;
	}
	const next = nextGpuTrial(state, input.tasks, config);
	if (next.kind === "done") {
		log.push(
			"gpu: lane done (every lane task has its trials or is at its attempt cap)",
		);
		return log;
	}
	if (next.kind === "wait") {
		log.push(`gpu: ${next.why}`);
		return log;
	}

	// 3. The GPU must be free: no sandbox on the Daytona account (the last verifier
	// included), no trial unit on the GPU host.
	const live = ops.liveSandboxes();
	if (!live.ok) {
		log.push(`gpu: cannot check the GPU target (${live.why}); not launching`);
		return log;
	}
	const present = live.sandboxes.filter((s) => !GONE_STATES.test(s.state));
	const orphans = present.filter((s) => s.lane);
	if (orphans.length) {
		const removed = ops.deleteSandboxes(orphans.map((s) => s.id));
		const sandboxes = orphans.map((s): BillingInterval => {
			const resources = {
				cpus: s.cpus,
				memoryGiB: s.memoryGiB,
				storageGiB: s.storageGiB,
				gpus: s.gpus,
			};
			const start = s.createdAt ?? now();
			const hourly = hourlyUsd(resources);
			return {
				id: s.id,
				role: `orphan:${s.attemptId ?? "?"}`,
				start,
				end: now(),
				hourlyUsd: hourly,
				usd: intervalUsd(hourly, start, now()),
				resources,
			};
		});
		appendLane({
			at: now(),
			type: "gpu-orphans",
			ids: orphans.map((s) => s.id),
			usd: sandboxes.reduce((s, x) => s + x.usd, 0),
			sandboxes,
		});
		log.push(
			`gpu: deleted ${orphans.length} leftover lane sandbox(es) ${orphans.map((s) => `${s.id.slice(0, 12)}(${s.state})`).join(", ")}: ${removed.slice(0, 200)}; launching after they are gone`,
		);
		return log;
	}
	const foreign = present.filter((s) => s.gpus > 0);
	if (foreign.length) {
		const ids = foreign.map((s) => s.id);
		const detail = foreign
			.map((s) => `${s.id.slice(0, 40)} ${s.state}`)
			.join(", ");
		const last = laneEvents.at(-1);
		if (!(last?.type === "gpu-blocked" && last.ids.join() === ids.join()))
			appendLane({ at: now(), type: "gpu-blocked", ids, detail });
		log.push(
			`gpu: something the lane did not start holds the GPU (${detail}); not launching`,
		);
		return log;
	}

	// 4. Budget: the worst case must fit the budget minus the buffer.
	const spec = next.task.gpuSpec;
	if (!spec) {
		log.push(
			`gpu: tasks.json has no gpuSpec for ${next.task.name}; rerun \`controller.ts tasks\``,
		);
		return log;
	}
	const worst = laneWorstCase(
		target,
		next.task.name,
		spec,
		laneEvents,
		config.overheadSec,
	);
	const spent = spentEstimate(laneEvents, budget, input.hostBilling ?? []);
	const gate = budgetGate({
		budgetUsd: budget.budgetUsd,
		spentUsd: spent,
		worstCaseUsd: worst,
		bufferUsd: config.bufferUsd,
	});
	const lastGate = lastGateEvent(laneEvents);
	if (!gate.ok) {
		const idle =
			target.kind === "docker"
				? `; the GPU host ${target.host} keeps billing $${target.hourlyUsd.toFixed(2)}/h while paused: stop it if no budget is coming`
				: "";
		if (
			!(
				lastGate?.type === "gpu-pause" &&
				lastGate.attemptId === next.attemptId &&
				lastGate.budgetUsd === budget.budgetUsd &&
				// A host target's spend grows while paused: re-journal per $1, not per tick.
				Math.floor(lastGate.spentUsd) === Math.floor(spent)
			)
		)
			appendLane({
				at: now(),
				type: "gpu-pause",
				attemptId: next.attemptId,
				task: next.task.name,
				target: host,
				budgetUsd: budget.budgetUsd,
				spentUsd: r2(spent),
				worstCaseUsd: r2(worst),
				bufferUsd: config.bufferUsd,
				needUsd: r2(gate.needUsd),
				reason: gate.reason + idle,
			});
		log.push(
			`GPU-PAUSE ${next.attemptId}: ${gate.reason}; add budget to continue: need $${gate.needUsd.toFixed(2)} (controller.ts gpu-budget <new total>)${idle}`,
		);
		return log;
	}
	if (lastGate?.type === "gpu-pause")
		appendLane({
			at: now(),
			type: "gpu-resume",
			attemptId: next.attemptId,
			budgetUsd: budget.budgetUsd as number,
			spentUsd: r2(spent),
			worstCaseUsd: r2(worst),
		});

	// 5. Launch: journal first, as the CPU lane does.
	journal.append({
		at: now(),
		type: "launch",
		attemptId: next.attemptId,
		task: next.task.name,
		batch: next.batch,
		host,
	});
	appendLane({
		at: now(),
		type: "gpu-launch",
		attemptId: next.attemptId,
		task: next.task.name,
		target: host,
		worstCaseUsd: r2(worst),
		spentUsd: r2(spent),
		budgetUsd: budget.budgetUsd as number,
	});
	try {
		ops.launch(next.attemptId, next.task.name);
		log.push(
			`gpu launch ${next.attemptId} on ${host} (worst case $${worst.toFixed(2)}, spent ~$${spent.toFixed(2)} of $${(budget.budgetUsd as number).toFixed(2)})`,
		);
	} catch (error) {
		const held = finishAttempt({
			journal,
			review: input.review,
			at: now(),
			attemptId: next.attemptId,
			task: next.task.name,
			outcome: {
				kind: "infra",
				reason: `launch failed: ${String(error).slice(0, 160)}`,
			},
		});
		if (held) log.push(held);
	}
	return log;
}

/** The lane's status for `controller.ts gpu-status`. */
export function laneStatus(input: {
	state: RunState;
	tasks: Task[];
	events: LaneEvent[];
	budget: Budget;
	config: LaneConfig;
	target?: GpuTarget;
	hostBilling?: BillingInterval[];
}) {
	const { state, events, budget, config } = input;
	const spent = spentEstimate(events, budget, input.hostBilling ?? []);
	const lastGate = lastGateEvent(events);
	const perTask = Object.fromEntries(
		config.order.map((name) => {
			const task = input.tasks.find((t) => t.name === name);
			const attempts = [...state.attempts.values()].filter(
				(a) => a.task === name,
			);
			const spend = events.filter(
				(e): e is Extract<LaneEvent, { type: "gpu-spend" }> =>
					e.type === "gpu-spend" && e.task === name,
			);
			return [
				name,
				{
					valid: attempts.filter((a) => a.outcome?.kind === "valid").length,
					passes: attempts.filter(
						(a) => a.outcome?.kind === "valid" && a.outcome.reward >= 1,
					).length,
					infra: attempts.filter((a) => a.outcome?.kind === "infra").length,
					inFlight: attempts.filter((a) => a.status !== "finished").length,
					worstCaseUsd:
						task?.gpuSpec && input.target
							? r2(
									laneWorstCase(
										input.target,
										name,
										task.gpuSpec,
										events,
										config.overheadSec,
									),
								)
							: null,
					spentUsd: r2(spend.reduce((s, e) => s + e.usd, 0)),
				},
			];
		}),
	);
	const n = nextGpuTrial(state, input.tasks, config);
	return {
		target: input.target ? laneHost(input.target) : "off",
		budgetUsd: budget.budgetUsd,
		budgetSource: budget.source,
		actualSpentUsd: budget.actualSpentUsd,
		actualAt: budget.actualAt,
		spentEstimateUsd: r2(spent),
		gpuHostUptimeUsd: r2(
			(input.hostBilling ?? []).reduce((s, x) => s + x.usd, 0),
		),
		bufferUsd: config.bufferUsd,
		paused: lastGate?.type === "gpu-pause" ? lastGate : null,
		next:
			n.kind === "launch" ? n.attemptId : n.kind === "wait" ? n.why : "done",
		perTask,
	};
}

/** Watchdog alerts from the lane journal: a budget pause, or the GPU held by something else. */
export function gpuLaneAlerts(events: LaneEvent[]): Alert[] {
	const alerts: Alert[] = [];
	const lastGate = lastGateEvent(events);
	if (lastGate?.type === "gpu-pause")
		alerts.push({
			level: "critical",
			key: `gpu-budget:${lastGate.attemptId}`,
			text: `GPU lane paused before ${lastGate.attemptId} (${lastGate.target}): add budget to continue: need $${lastGate.needUsd.toFixed(2)} (budget ${lastGate.budgetUsd === null ? "not set" : `$${lastGate.budgetUsd.toFixed(2)}`}, spent ~$${lastGate.spentUsd.toFixed(2)}, worst case $${lastGate.worstCaseUsd.toFixed(2)} + $${lastGate.bufferUsd} buffer). Then: controller.ts gpu-budget <new total>`,
		});
	const last = events.at(-1);
	if (last?.type === "gpu-blocked")
		alerts.push({
			level: "critical",
			key: `gpu-blocked:${last.ids.join(",")}`,
			text: `GPU lane blocked: something it did not start holds the GPU (${sanitizeLine(last.detail, 160)}); delete it or wait`,
		});
	return alerts;
}
