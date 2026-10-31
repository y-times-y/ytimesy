/**
 * GPU cost model for the TB4 GPU lane (docs/tb4-run-controller.md, "GPU lane").
 * Pure: no I/O, so the worst case of a trial can be checked offline from the real
 * task.toml values. Two price tables:
 *
 * - Daytona: per second while a sandbox exists, per resource: H100 (Daytona's
 *   "preemptible" price), vCPU, memory GiB, and storage GiB above the free 5 GiB.
 *   Paid in money: Daytona's free credits do not cover GPU sandboxes.
 * - AWS GPU host (p5.4xlarge, 1 H100): per host-hour while the host runs, trials or
 *   not. Paid from AWS credits.
 */

export const DAYTONA_PRICES = {
	h100PerHour: 2.27,
	vcpuPerHour: 0.0504,
	memoryGiBPerHour: 0.0162,
	storageGiBPerHour: 0.000108,
	freeStorageGiB: 5,
} as const;
export type DaytonaPrices = typeof DAYTONA_PRICES;

/** One sandbox's billed resources (Daytona units: memory and disk in GiB). */
export type SandboxResources = {
	cpus: number;
	memoryGiB: number;
	storageGiB: number;
	gpus: number;
};

export function hourlyUsd(
	r: SandboxResources,
	p: DaytonaPrices = DAYTONA_PRICES,
) {
	return (
		r.gpus * p.h100PerHour +
		r.cpus * p.vcpuPerHour +
		r.memoryGiB * p.memoryGiBPerHour +
		Math.max(0, r.storageGiB - p.freeStorageGiB) * p.storageGiBPerHour
	);
}

export function sandboxUsd(
	r: SandboxResources,
	seconds: number,
	p: DaytonaPrices = DAYTONA_PRICES,
) {
	return (hourlyUsd(r, p) * Math.max(0, seconds)) / 3600;
}

/**
 * What one GPU trial can hold on Daytona, from its task.toml: the agent sandbox for
 * at most [agent].timeout_sec, then (environment_mode = "separate") a verifier
 * sandbox for at most [verifier].timeout_sec. A shared verifier runs inside the
 * agent sandbox, which then lives for both timeouts.
 */
export type GpuTaskSpec = {
	agent: SandboxResources;
	agentTimeoutSec: number;
	verifier: SandboxResources | null;
	verifierTimeoutSec: number;
};

const num = (v: unknown) => Number(v ?? 0) || 0;
function envResources(env: Record<string, unknown>): SandboxResources {
	return {
		cpus: num(env.cpus) || 1,
		memoryGiB: num(env.memory_mb) / 1024 || 2,
		storageGiB: num(env.storage_mb) / 1024 || 10,
		gpus: num(env.gpus),
	};
}

/** The spec of a task.toml (parsed); null for a task with no GPU in either environment. */
export function gpuTaskSpec(toml: Record<string, unknown>): GpuTaskSpec | null {
	const env = (toml.environment ?? {}) as Record<string, unknown>;
	const verifier = (toml.verifier ?? {}) as Record<string, unknown>;
	const venv = (verifier.environment ?? {}) as Record<string, unknown>;
	const agent = (toml.agent ?? {}) as Record<string, unknown>;
	const separate =
		verifier.environment_mode === "separate" ||
		env.environment_mode === "separate";
	const spec: GpuTaskSpec = {
		agent: envResources(env),
		agentTimeoutSec: num(agent.timeout_sec),
		verifier: separate ? envResources(venv) : null,
		verifierTimeoutSec: num(verifier.timeout_sec),
	};
	return spec.agent.gpus > 0 || (spec.verifier?.gpus ?? 0) > 0 ? spec : null;
}

/**
 * Allowance per sandbox beyond its timeout: creation from the snapshot, the agent
 * install before the agent clock starts, uploads/downloads, and deletion. Default
 * 10 min (TB4_GPU_OVERHEAD_MIN).
 */
export const DEFAULT_SANDBOX_OVERHEAD_SEC = 600;

/** The most one trial can cost: every sandbox held to its time limit plus the allowance. */
export function worstCaseUsd(
	spec: GpuTaskSpec,
	overheadSec = DEFAULT_SANDBOX_OVERHEAD_SEC,
	p: DaytonaPrices = DAYTONA_PRICES,
) {
	const agentSec =
		spec.agentTimeoutSec +
		(spec.verifier ? 0 : spec.verifierTimeoutSec) +
		overheadSec;
	const agentUsd = sandboxUsd(spec.agent, agentSec, p);
	const verifierUsd = spec.verifier
		? sandboxUsd(spec.verifier, spec.verifierTimeoutSec + overheadSec, p)
		: 0;
	return {
		usd: agentUsd + verifierUsd,
		agentUsd,
		verifierUsd,
		hours:
			(agentSec + (spec.verifier ? spec.verifierTimeoutSec + overheadSec : 0)) /
			3600,
	};
}

/**
 * A typical trial from a mean wall time that includes the verifier (e.g. Codex's
 * public job): that time billed at the agent sandbox's rate (the three TB4 GPU tasks
 * give the verifier the same resources), plus the allowance per sandbox.
 */
export function typicalUsd(
	spec: GpuTaskSpec,
	meanSeconds: number,
	overheadSec = DEFAULT_SANDBOX_OVERHEAD_SEC,
	p: DaytonaPrices = DAYTONA_PRICES,
) {
	return (
		sandboxUsd(spec.agent, meanSeconds + overheadSec, p) +
		(spec.verifier ? sandboxUsd(spec.verifier, overheadSec, p) : 0)
	);
}

/* ---------- AWS GPU hosts (Docker target) ---------- */

export type HostMarket = "on-demand" | "capacity-block";
/**
 * Hourly price of one GPU host by instance type and market. p5.4xlarge has one H100;
 * $5.97/h per H100 for both on-demand and Capacity Block (confirm the day of the run;
 * TB4_P5_4XL_HOURLY_USD and TB4_P5_4XL_CB_HOURLY_USD override).
 */
export function awsGpuHostHourly(
	type: string,
	market: HostMarket,
	env: Record<string, string | undefined> = {},
): number {
	const n = (v: string | undefined, d: number) =>
		v !== undefined && v.trim() !== "" && Number.isFinite(Number(v))
			? Number(v)
			: d;
	if (type === "p5.4xlarge")
		return market === "capacity-block"
			? n(env.TB4_P5_4XL_CB_HOURLY_USD, 5.97)
			: n(env.TB4_P5_4XL_HOURLY_USD, 5.97);
	throw new Error(`no GPU host price for ${type} (${market})`);
}

/**
 * The most one trial can cost on a GPU host: the host's time while the agent and the
 * verifier (containers on the same host, sharing its GPU) run to their limits, plus
 * the allowance per container. The host also bills while idle; that is counted in
 * the lane's spend from the host's own uptime, not here.
 */
export function hostWorstCaseUsd(
	spec: GpuTaskSpec,
	hourly: number,
	overheadSec = DEFAULT_SANDBOX_OVERHEAD_SEC,
) {
	const seconds =
		spec.agentTimeoutSec +
		spec.verifierTimeoutSec +
		overheadSec * (spec.verifier ? 2 : 1);
	return { usd: (hourly * seconds) / 3600, hours: seconds / 3600 };
}

export function hostTypicalUsd(
	spec: GpuTaskSpec,
	meanSeconds: number,
	hourly: number,
	overheadSec = DEFAULT_SANDBOX_OVERHEAD_SEC,
) {
	return (
		(hourly * (meanSeconds + overheadSec * (spec.verifier ? 2 : 1))) / 3600
	);
}
