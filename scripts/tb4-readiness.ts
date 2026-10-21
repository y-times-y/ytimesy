/**
 * TB4 readiness gate (docs/tb4-readiness.md): runs every automatable check
 * read-only and prints PASS / FAIL / MANUAL per gate item with its evidence.
 * Writes .ytimesy/tb4-readiness/<ts>/report.json.
 *
 *   node --env-file=.env --import tsx scripts/tb4-readiness.ts \
 *     [--dataset ../cloud/.ytimesy/tb4-dataset] [--bridge ../cloud-bridge2] \
 *     [--route codex-subscription] [--variant lead=fusion,review=on,checkerMode=single,rigor=on] \
 *     [--preflight <bridge>/.ytimesy/harbor-v2/preflight/preflight.json] [--run-env <file>] \
 *     [--rule benchmarks/evaluation/tb4-<run>.md] [--offline]
 *
 * Never calls a model, never launches or changes a cloud resource, never
 * prints a secret (only booleans, counts and statuses). AWS calls are
 * read-only (Service Quotas GetServiceQuota, Bedrock list/availability),
 * signed with the `harbor` profile of ~/.aws/credentials.
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

type Status = "PASS" | "FAIL" | "MANUAL";
type Check = {
	item: string;
	name: string;
	status: Status;
	evidence: string;
	command?: string;
};

const repo = resolve(dirname(new URL(import.meta.url).pathname), "..");
const sibling = (name: string) => resolve(repo, "..", name);
const { values: flags } = parseArgs({
	options: {
		dataset: { type: "string" },
		bridge: { type: "string" },
		route: { type: "string", default: "codex-subscription" },
		variant: {
			type: "string",
			default: "lead=fusion,review=on,checkerMode=single,rigor=on",
		},
		"pair-variant": {
			type: "string",
			default: "lead=fusion,review=on,checkerMode=pair,rigor=on",
		},
		preflight: { type: "string" },
		"preflight-max-age-days": { type: "string", default: "7" },
		"run-env": { type: "string" },
		rule: { type: "string" },
		"bedrock-models": {
			type: "string",
			default: "claude-opus-5-5,claude-haiku-5-5,gpt-6.1-sol",
		},
		trials: { type: "string", default: "5" },
		offline: { type: "boolean", default: false },
	},
});

const firstExisting = (...paths: string[]) =>
	paths.find((path) => existsSync(path)) ?? paths[0];
const DATASET = resolve(
	flags.dataset ??
		firstExisting(
			join(repo, ".ytimesy/tb4-dataset"),
			sibling("cloud/.ytimesy/tb4-dataset"),
		),
);
const BRIDGE = resolve(
	flags.bridge ??
		(existsSync(join(repo, "evals/harbor_v2/config.ts"))
			? repo
			: sibling("cloud-bridge2")),
);
const PREFLIGHT = resolve(
	flags.preflight ??
		join(BRIDGE, ".ytimesy/harbor-v2/preflight/preflight.json"),
);
const TRIALS = Number(flags.trials);
const checks: Check[] = [];
const add = (check: Check) => {
	checks.push(check);
	return check;
};
const errorText = (error: unknown) =>
	(error instanceof Error ? error.message : String(error))
		.replace(/(key|token|secret|authorization)[^\s,;]*/gi, "$1=<redacted>")
		.slice(0, 200);

/* ---------- dataset and task classes ---------- */

type TaskInfo = {
	name: string;
	gpus: number;
	gpuTypes: string[];
	mcp: boolean;
	sidecars: string[];
	storageMb: number;
	verifierStorageMb: number;
	cpus: number;
	memoryMb: number;
	agentTimeoutSec: number;
	separateVerifier: boolean;
	classes: string[];
};

function loadTasks(): TaskInfo[] {
	const names = readdirSync(DATASET).filter((name) =>
		existsSync(join(DATASET, name, "task.toml")),
	);
	// One isolated python call parses every task.toml (tomllib; no tests or solutions read).
	const tomls = JSON.parse(
		execFileSync(
			"python3",
			[
				"-I",
				"-c",
				"import json,sys,tomllib\nprint(json.dumps({p: tomllib.load(open(p,'rb')) for p in sys.argv[1:]}))",
				...names.map((name) => join(DATASET, name, "task.toml")),
			],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		),
	) as Record<string, Record<string, Record<string, unknown>>>;
	return names.map((name) => {
		const toml = tomls[join(DATASET, name, "task.toml")];
		const environment = (toml.environment ?? {}) as Record<string, unknown>;
		const verifier = (toml.verifier ?? {}) as Record<string, unknown>;
		const verifierEnvironment = (verifier.environment ?? {}) as Record<
			string,
			unknown
		>;
		const compose = join(DATASET, name, "environment/docker-compose.yaml");
		let sidecars: string[] = [];
		if (existsSync(compose)) {
			const services = (
				parseYaml(readFileSync(compose, "utf8")) as {
					services?: Record<string, unknown>;
				}
			)?.services;
			sidecars = Object.keys(services ?? {}).filter((s) => s !== "main");
		}
		const mcp =
			Array.isArray(environment.mcp_servers) &&
			environment.mcp_servers.length > 0;
		const gpus = Number(environment.gpus ?? 0);
		const storageMb = Number(environment.storage_mb ?? 0);
		const classes = [
			gpus > 0 ? "gpu" : "cpu",
			...(mcp ? ["mcp"] : []),
			...(sidecars.length ? ["sidecar"] : []),
			...(storageMb > 64 * 1024 ? ["large-disk"] : []),
		];
		return {
			name,
			gpus,
			gpuTypes: (environment.gpu_types as string[]) ?? [],
			mcp,
			sidecars,
			storageMb,
			verifierStorageMb: Number(verifierEnvironment.storage_mb ?? 0),
			cpus: Number(environment.cpus ?? 0),
			memoryMb: Number(environment.memory_mb ?? 0),
			agentTimeoutSec: Number(
				(toml.agent as Record<string, unknown>)?.timeout_sec ?? 0,
			),
			separateVerifier: verifier.environment_mode === "separate",
			classes,
		};
	});
}

let tasks: TaskInfo[] = [];
try {
	tasks = loadTasks();
	add({
		item: "1",
		name: "dataset present (66 tasks)",
		status: tasks.length === 66 ? "PASS" : "FAIL",
		evidence: `${tasks.length} tasks with task.toml in ${DATASET}`,
	});
	const byClass = (cls: string) =>
		tasks.filter((task) => task.classes.includes(cls)).map((t) => t.name);
	const largest = [...tasks].sort((a, b) => b.storageMb - a.storageMb)[0];
	add({
		item: "1",
		name: "task classes (from task.toml)",
		status: "PASS",
		evidence: `cpu ${byClass("cpu").length}, gpu ${byClass("gpu").length} [${byClass("gpu").join(", ")}], mcp ${byClass("mcp").length} [${byClass("mcp").join(", ")}], sidecar ${byClass("sidecar").length}, large-disk>64GB ${byClass("large-disk").length} [${byClass("large-disk").join(", ")}]; largest storage ${largest?.name} ${Math.round((largest?.storageMb ?? 0) / 1024)} GB; max cpus ${Math.max(...tasks.map((t) => t.cpus))}; agent timeout max ${Math.max(...tasks.map((t) => t.agentTimeoutSec)) / 3600} h`,
	});
} catch (error) {
	add({
		item: "1",
		name: "dataset present (66 tasks)",
		status: "FAIL",
		evidence: `cannot read ${DATASET}: ${errorText(error)}`,
	});
}

/* ---------- 1. preflight records ---------- */

try {
	const file = JSON.parse(readFileSync(PREFLIGHT, "utf8")) as {
		at: string;
		environment: string;
		harbor: string;
		tasks: Record<string, { passed: boolean; reason: string | null }>;
	};
	const maxAgeMs = Number(flags["preflight-max-age-days"]) * 86_400_000;
	const ageMs = Date.now() - Date.parse(file.at);
	const passed = tasks.filter((t) => file.tasks[t.name]?.passed);
	const failed = tasks.filter(
		(t) => file.tasks[t.name] && !file.tasks[t.name].passed,
	);
	const missing = tasks.filter((t) => !file.tasks[t.name]);
	add({
		item: "1",
		name: "oracle=1 / nop=0 preflight per task (bridge preflight.json)",
		status:
			passed.length === tasks.length && tasks.length > 0 && ageMs <= maxAgeMs
				? "PASS"
				: "FAIL",
		evidence: `${passed.length}/${tasks.length} passed, ${failed.length} failed${failed.length ? ` [${failed.map((t) => t.name).join(", ")}]` : ""}, ${missing.length} missing; file written ${file.at} (${(ageMs / 86_400_000).toFixed(1)} d ago, max ${flags["preflight-max-age-days"]} d), env ${file.environment}, harbor "${file.harbor}"`,
		command: missing.length
			? `cd ${BRIDGE} && node --import tsx evals/harbor_v2/preflight.ts --env <docker|daytona> --jobs-dir .ytimesy/harbor-v2/preflight --tasks ${missing
					.slice(0, 4)
					.map((t) => t.name)
					.join(
						",",
					)}${missing.length > 4 ? ",..." : ""}  # GPU tasks on the AWS p5 host`
			: undefined,
	});
} catch (error) {
	add({
		item: "1",
		name: "oracle=1 / nop=0 preflight per task (bridge preflight.json)",
		status: "FAIL",
		evidence: `no readable preflight file at ${PREFLIGHT}: ${errorText(error)}`,
		command: `cd ${BRIDGE} && node --import tsx evals/harbor_v2/preflight.ts --tasks <all 66> --env docker`,
	});
}
add({
	item: "1",
	name: "real agent (capped) reaches the real grader; largest workspace and agent-timeout path",
	status: "MANUAL",
	evidence:
		"bridge preflight.ts runs oracle and nop only; capped agent + jax-scale workspace transfer (up to 150 GB /app) must be recorded per task class (see item 2)",
	command:
		"harbor run ... -i terminal-bench/jax-speedrun-gpu --agent-timeout-multiplier 0.1 on the p5 host; record /app size, transfer manifest ok, verifier reward set",
});

/* ---------- 2. harness smoke per class + bridge config ---------- */

const plannedVariant = flags.variant as string;
async function bridgeConfigCheck(variant: string, label: string) {
	const configPath = join(BRIDGE, "evals/harbor_v2/config.ts");
	if (!existsSync(configPath)) {
		add({
			item: "2",
			name: `bridge config parses (${label})`,
			status: "FAIL",
			evidence: `no bridge v2 at ${configPath}`,
		});
		return;
	}
	const route = flags.route as string;
	const paid = route !== "codex-subscription";
	try {
		const { harborBridgeConfig } = (await import(
			pathToFileURL(configPath).href
		)) as {
			harborBridgeConfig: (env: Record<string, string>) => {
				variant: Record<string, unknown>;
				roles: Record<string, { modelId: string }>;
				trialUsdCap: number | null;
			};
		};
		const config = harborBridgeConfig({
			YTIMESY_HARBOR_ROUTE: route,
			YTIMESY_HARBOR_APPROVED: route,
			YTIMESY_HARBOR_VARIANT: variant,
			...(paid
				? {
						YTIMESY_HARBOR_TOTAL_USD_CAP: "1",
						YTIMESY_HARBOR_SPEND_LEDGER: "/dev/null",
					}
				: {}),
		});
		const v = config.variant;
		const ok = ["lead", "review", "checkerMode", "rigor"].every(
			(key) =>
				variant.includes(`${key}=${String(v[key])}`) ||
				!variant.includes(`${key}=`),
		);
		add({
			item: "2",
			name: `bridge config parses (${label})`,
			status: ok ? "PASS" : "FAIL",
			evidence: `route ${route}: lead=${v.lead} review=${v.review} checkerMode=${v.checkerMode} rigor=${v.rigor} subagents=${v.subagents}; bridge ${BRIDGE} (${gitHead(BRIDGE)})`,
		});
	} catch (error) {
		add({
			item: "2",
			name: `bridge config parses (${label})`,
			status: "FAIL",
			evidence: `harborBridgeConfig refused "${variant}" on ${route}: ${errorText(error)}`,
		});
	}
}

function gitHead(dir: string) {
	try {
		const head = execFileSync(
			"git",
			["-C", dir, "rev-parse", "--short", "HEAD"],
			{
				encoding: "utf8",
			},
		).trim();
		const dirty = execFileSync(
			"git",
			["-C", dir, "status", "--porcelain", "--", "evals", "src"],
			{ encoding: "utf8" },
		).trim();
		return `${head}${dirty ? `, ${dirty.split("\n").length} uncommitted files in evals/src` : ", clean"}`;
	} catch {
		return "not a git checkout";
	}
}

await bridgeConfigCheck(plannedVariant, `planned: ${plannedVariant}`);
await bridgeConfigCheck(
	flags["pair-variant"] as string,
	"checkerMode=pair arm",
);

function findTrials(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	for (const job of readdirSync(root, { withFileTypes: true })) {
		if (!job.isDirectory()) continue;
		for (const trial of readdirSync(join(root, job.name), {
			withFileTypes: true,
		}))
			if (
				trial.isDirectory() &&
				trial.name.includes("__") &&
				existsSync(join(root, job.name, trial.name, "result.json"))
			)
				out.push(join(root, job.name, trial.name));
	}
	return out;
}
{
	const roots = [
		join(BRIDGE, ".ytimesy/harbor-v2/smoke"),
		join(repo, ".ytimesy/harbor-v2/smoke"),
		join(repo, ".ytimesy/tb4-readiness/smoke"),
	];
	const classTasks = new Map(tasks.map((t) => [t.name, t.classes]));
	const covered = new Map<string, string>();
	let seen = 0;
	for (const trial of roots.flatMap(findTrials)) {
		seen++;
		try {
			const result = JSON.parse(
				readFileSync(join(trial, "result.json"), "utf8"),
			);
			const reward = result.verifier_result?.rewards?.reward;
			const tracePath = join(trial, "agent/ytimesy-trace.json");
			const trace = existsSync(tracePath)
				? JSON.parse(readFileSync(tracePath, "utf8"))
				: null;
			const variant = String(trace?.variant ?? "");
			const matches = ["lead=fusion", "review=on"].every((flag) =>
				variant.includes(flag),
			);
			if (typeof reward !== "number" || result.exception_info || !matches)
				continue;
			const task = basename(trial).split("__")[0];
			for (const cls of classTasks.get(task) ?? [])
				if (!covered.has(cls)) covered.set(cls, basename(trial));
		} catch {}
	}
	for (const cls of ["cpu", "gpu", "mcp", "sidecar", "large-disk"]) {
		const example = tasks.find((t) => t.classes.includes(cls))?.name ?? "?";
		add({
			item: "2",
			name: `capped real-agent smoke, planned variant, class ${cls}`,
			status: covered.has(cls) ? "PASS" : "MANUAL",
			evidence: covered.has(cls)
				? `graded trial ${covered.get(cls)} (variant has lead=fusion, review=on; reward set; no exception)`
				: `no graded smoke trial with the planned variant for this class (${seen} trial dirs scanned)`,
			command: covered.has(cls)
				? undefined
				: `docs/tb4-readiness.md item 2: harbor run -i terminal-bench/${example} -a evals.harbor_v2.agent:YtimesyHarborV2Agent -k 1 -n 1 --agent-timeout-multiplier 0.125 --jobs-dir .ytimesy/tb4-readiness/smoke (YTIMESY_HARBOR_VARIANT=${plannedVariant})`,
		});
	}
}

/* ---------- 3. injected failures ---------- */

function grepBridge(pattern: string) {
	try {
		return execFileSync(
			"grep",
			[
				"-rliE",
				pattern,
				join(BRIDGE, "evals/harbor_v2"),
				...readdirSync(join(BRIDGE, "tests"))
					.filter((f) => f.startsWith("harbor-v2"))
					.map((f) => join(BRIDGE, "tests", f)),
			],
			{ encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((path) => path.replace(`${BRIDGE}/`, ""));
	} catch {
		return [];
	}
}
const injections: [string, string, string][] = [
	[
		"dropped connection (ECONNRESET mid-request)",
		"ECONNRESET|socket hang up|fetch failed|connection reset",
		"run a capped smoke with a fault proxy (toxiproxy reset_peer) between the bridge and the provider; expect the guard to resend, or the trial to fail with exception_info (infra, rerun)",
	],
	[
		"stream cut mid-response",
		"without a terminal event|resend",
		"fault proxy truncating one SSE response before its terminal event; transport.log must show resend and terminal set",
	],
	[
		"VM/host restart mid-trial",
		"reboot|host restart",
		"reboot the trial host during a capped smoke; the controller must mark the trial infra (agent never finished, no reward) and rerun it per the rule",
	],
	[
		"Codex usage limit hit",
		"usage_limit|limit_reached|usage limit|429",
		"point the subscription transport at a stub returning 429 usage_limit_reached; expect the trial to stop cleanly (exception, not a 0) and the controller to pause until wham/usage clears",
	],
	[
		"network outage (provider unreachable 2-10 min)",
		"ENOTFOUND|ETIMEDOUT|EAI_AGAIN",
		"block egress (pf/iptables) for 5 min during a capped smoke; expect retry then recovery, or a clean infra failure",
	],
];
for (const [name, pattern, how] of injections) {
	const files = grepBridge(pattern);
	add({
		item: "3",
		name: `injected failure: ${name}`,
		status: "MANUAL",
		evidence: files.length
			? `handling code/tests mention it: ${files.slice(0, 4).join(", ")} (synthetic only; not proven on a real trial)`
			: "no handling found in evals/harbor_v2 or tests",
		command: how,
	});
}

/* ---------- AWS (read-only, SigV4, harbor profile) ---------- */

type Creds = { id: string; secret: string; token?: string };
function awsCreds(): Creds | null {
	try {
		const text = readFileSync(join(homedir(), ".aws/credentials"), "utf8");
		const section = text
			.split(/^\[/m)
			.find((part) => part.startsWith("harbor]"));
		if (!section) return null;
		const get = (key: string) =>
			section.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, "m"))?.[1];
		const id = get("aws_access_key_id");
		const secret = get("aws_secret_access_key");
		return id && secret
			? { id, secret, token: get("aws_session_token") }
			: null;
	} catch {
		return null;
	}
}
const sha256 = (data: string) =>
	createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
	createHmac("sha256", key).update(data).digest();
async function awsRequest(input: {
	creds: Creds;
	service: string;
	region: string;
	host: string;
	method: "GET" | "POST";
	segments?: string[];
	query?: Record<string, string>;
	body?: string;
	headers?: Record<string, string>;
}) {
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const day = amzDate.slice(0, 8);
	const segments = input.segments ?? [];
	const path = `/${segments.map(encodeURIComponent).join("/")}`;
	const canonicalPath = `/${segments.map((s) => encodeURIComponent(encodeURIComponent(s))).join("/")}`;
	const query = Object.entries(input.query ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
	const body = input.body ?? "";
	const headers: Record<string, string> = {
		host: input.host,
		"x-amz-date": amzDate,
		"x-amz-content-sha256": sha256(body),
		...(input.creds.token ? { "x-amz-security-token": input.creds.token } : {}),
		...(input.headers ?? {}),
	};
	const names = Object.keys(headers)
		.map((h) => h.toLowerCase())
		.sort();
	const lower = Object.fromEntries(
		Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]),
	);
	const canonical = [
		input.method,
		canonicalPath,
		query,
		names.map((n) => `${n}:${lower[n]}\n`).join(""),
		names.join(";"),
		sha256(body),
	].join("\n");
	const scope = `${day}/${input.region}/${input.service}/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join(
		"\n",
	);
	let key = hmac(`AWS4${input.creds.secret}`, day);
	for (const part of [input.region, input.service, "aws4_request"])
		key = hmac(key, part);
	const signature = createHmac("sha256", key).update(toSign).digest("hex");
	const response = await fetch(
		`https://${input.host}${path}${query ? `?${query}` : ""}`,
		{
			method: input.method,
			headers: {
				...headers,
				authorization: `AWS4-HMAC-SHA256 Credential=${input.creds.id}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
			},
			body: input.method === "POST" ? body : undefined,
			signal: AbortSignal.timeout(20_000),
		},
	);
	const text = await response.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: response.status, json, text: text.slice(0, 200) };
}

/* ---------- 4. capacity ---------- */

const gpuTasks = tasks.filter((t) => t.gpus > 0);
const creds = flags.offline ? null : awsCreds();
if (flags.offline) {
	add({
		item: "4",
		name: "AWS p5 quota",
		status: "MANUAL",
		evidence: "--offline",
	});
} else if (!creds) {
	add({
		item: "4",
		name: "AWS p5 quota (Running On-Demand P instances, L-417A185B)",
		status: "FAIL",
		evidence: "no [harbor] profile with keys in ~/.aws/credentials",
	});
} else {
	const needed = 16; // p5.4xlarge = 16 vCPU, 1 H100
	for (const region of ["us-east-1", "us-west-2"]) {
		try {
			const r = await awsRequest({
				creds,
				service: "servicequotas",
				region,
				host: `servicequotas.${region}.amazonaws.com`,
				method: "POST",
				body: JSON.stringify({ ServiceCode: "ec2", QuotaCode: "L-417A185B" }),
				headers: {
					"content-type": "application/x-amz-json-1.1",
					"x-amz-target": "ServiceQuotasV20190624.GetServiceQuota",
				},
			});
			const value = (r.json as { Quota?: { Value?: number } })?.Quota?.Value;
			const concurrent = value ? Math.floor(value / needed) : 0;
			// Each GPU trial holds one H100 for the agent and one for its separate verifier.
			const gpuTrialHours = gpuTasks.reduce(
				(sum, t) => sum + (t.agentTimeoutSec / 3600 + 2) * TRIALS,
				0,
			);
			add({
				item: "4",
				name: `AWS p5 quota ${region} (L-417A185B, vCPU)`,
				status:
					r.status === 200 && concurrent >= (region === "us-east-1" ? 2 : 0)
						? "PASS"
						: region === "us-east-1"
							? "FAIL"
							: "PASS",
				evidence:
					r.status === 200
						? `${value} vCPU = ${concurrent} concurrent p5.4xlarge (1 H100 each); ${gpuTasks.length} GPU tasks x ${TRIALS} trials, worst case ~${Math.round(gpuTrialHours)} H100-hours of agent+verifier, ~${concurrent ? Math.round(gpuTrialHours / concurrent) : "inf"} h wall at full use`
						: `HTTP ${r.status} ${r.text.replace(/[A-Z0-9]{16,}/g, "<id>")}`,
			});
		} catch (error) {
			add({
				item: "4",
				name: `AWS p5 quota ${region}`,
				status: "FAIL",
				evidence: errorText(error),
			});
		}
	}
}
add({
	item: "4",
	name: "AWS account can launch (no verification hold) and a p5 capacity reservation/spot fallback exists",
	status: "MANUAL",
	evidence:
		"not readable without launching; the 2026-10-12 hold blocked new launches. Harbor 0.24 has no EC2 environment: GPU trials run Harbor -e docker on a p5 host",
	command:
		"EC2 console: launch one p5.4xlarge in us-east-1 (owner approval; paid), nvidia-smi shows H100, terminate",
});
{
	const largest = [...tasks].sort((a, b) => b.storageMb - a.storageMb)[0];
	add({
		item: "4",
		name: "host count and storage for 66x5 trials and largest workspace",
		status: "MANUAL",
		evidence: `${tasks.length * TRIALS} trials; one concurrent trial of every task needs ${tasks.reduce((s, t) => s + t.cpus, 0)} vCPU and ${Math.round(tasks.reduce((s, t) => s + t.memoryMb, 0) / 1024)} GB RAM (agent env only; separate verifiers add more); largest declared storage ${largest?.name} ${Math.round((largest?.storageMb ?? 0) / 1024)} GB (jax /app reached 147 GB in the rerun); Freestyle caps disk at 64 GB and 8 vCPU per VM`,
		command:
			"record the host plan (provider, vCPU, disk, concurrency per class) in the run rule; the p5 host needs >= 500 GB local NVMe free for jax",
	});
	add({
		item: "4",
		name: "provider spend limits (Modal, Daytona, Freestyle) cover the run",
		status: "MANUAL",
		evidence:
			"no read-only API for the billing-cycle limits; Modal's limit killed every fp8 trial on 2026-10-13",
		command:
			"screenshot each provider's billing page: limit, used, remaining; write the numbers in the run rule",
	});
}
try {
	const info = execFileSync(
		"docker",
		[
			"info",
			"--format",
			"{{.ServerVersion}} {{.NCPU}} {{.MemTotal}} {{.OperatingSystem}}",
		],
		{ encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
	)
		.trim()
		.split(" ");
	add({
		item: "4",
		name: "Docker daemon healthy (this machine)",
		status: "PASS",
		evidence: `server ${info[0]}, NCPU ${info[1]}, mem ${Math.round(Number(info[2]) / 2 ** 30)} GiB, ${info.slice(3).join(" ")} (on each trial host also check NCPU after any CPU resize: dockerd caches it)`,
	});
} catch (error) {
	add({
		item: "4",
		name: "Docker daemon healthy (this machine)",
		status: "FAIL",
		evidence: errorText(error),
	});
}
{
	let harbor = "";
	try {
		const archive = join(homedir(), ".cache/uv/archive-v0");
		for (const entry of existsSync(archive) ? readdirSync(archive) : []) {
			const python = join(archive, entry, "bin/python");
			if (!existsSync(python)) continue;
			try {
				const version = execFileSync(
					python,
					[
						"-I",
						"-c",
						"import importlib.metadata as m; print(m.version('harbor'))",
					],
					{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
				).trim();
				if (version === "0.24.0") {
					harbor = version;
					break;
				}
			} catch {}
		}
	} catch {}
	add({
		item: "4",
		name: "Harbor 0.24.0 available (uv cache)",
		status: harbor ? "PASS" : "FAIL",
		evidence: harbor
			? "harbor 0.24.0 importable from a uv archive"
			: "no uv archive with harbor 0.24.0 on this machine (uv cache empty); the controller must have it pinned: `uvx --from harbor==0.24.0 harbor --help`",
	});
}

/* ---------- 5. model capacity and spend caps ---------- */

if (flags.offline) {
	add({
		item: "5",
		name: "Codex usage windows",
		status: "MANUAL",
		evidence: "--offline",
	});
} else if (!process.env.DATABASE_URL) {
	add({
		item: "5",
		name: "Codex usage windows (wham/usage, read-only)",
		status: "FAIL",
		evidence:
			"DATABASE_URL not set (run with --env-file=.env); the subscription owner is read from the dev database",
	});
} else {
	try {
		const [{ codexUsage }, { subscriptionOwner }] = await Promise.all([
			import("./hard-set/vm"),
			import("./smoke/eval-user"),
		]);
		const usage = await Promise.race([
			subscriptionOwner().then(codexUsage),
			new Promise<string>((_, fail) =>
				setTimeout(() => fail(new Error("timed out after 45 s")), 45_000),
			),
		]);
		const fiveHour = Number(
			usage.match(/5h (\d+(?:\.\d+)?)%/)?.[1] ?? Number.NaN,
		);
		const week = Number(
			usage.match(/week (\d+(?:\.\d+)?)%/)?.[1] ?? Number.NaN,
		);
		add({
			item: "5",
			name: "Codex usage windows (wham/usage, read-only)",
			status:
				!usage.includes("LIMIT REACHED") && Number.isFinite(week) && week < 50
					? "PASS"
					: "FAIL",
			evidence: `${usage}; need weekly < 50% at start. Plus measured ~20 builder runs per 5 h window: ${tasks.length * TRIALS} trials need ~${Math.ceil((tasks.length * TRIALS) / 20)} windows (${Math.ceil(((tasks.length * TRIALS) / 20) * 5)} h) unless the plan is upgraded; pace with codex-usage-wait between trials`,
		});
		void fiveHour;
	} catch (error) {
		add({
			item: "5",
			name: "Codex usage windows (wham/usage, read-only)",
			status: "FAIL",
			evidence: errorText(error),
		});
	}
}

if (!flags.offline && creds) {
	const wanted = (flags["bedrock-models"] as string).split(",").filter(Boolean);
	for (const region of ["us-east-1"]) {
		try {
			const list = await awsRequest({
				creds,
				service: "bedrock",
				region,
				host: `bedrock.${region}.amazonaws.com`,
				method: "GET",
				segments: ["foundation-models"],
			});
			const ids = (
				(list.json as { modelSummaries?: { modelId: string }[] })
					?.modelSummaries ?? []
			).map((m) => m.modelId);
			for (const want of wanted) {
				const needle = want.replace(/\./g, "[.-]");
				const id =
					ids.find((m) => new RegExp(`${needle}(?:$|[-:v])`).test(m)) ??
					ids.find((m) => new RegExp(needle).test(m));
				if (!id) {
					add({
						item: "5",
						name: `Bedrock ${want} (${region})`,
						status: "FAIL",
						evidence: `not in ListFoundationModels (HTTP ${list.status}, ${ids.length} models listed)`,
					});
					continue;
				}
				const r = await awsRequest({
					creds,
					service: "bedrock",
					region,
					host: `bedrock.${region}.amazonaws.com`,
					method: "GET",
					segments: ["foundation-model-availability", id],
				});
				const a = r.json as {
					agreementAvailability?: { status?: string };
					authorizationStatus?: string;
					entitlementAvailability?: string;
					regionAvailability?: string;
				} | null;
				const usable =
					r.status === 200 &&
					a?.agreementAvailability?.status === "AVAILABLE" &&
					a?.authorizationStatus === "AUTHORIZED" &&
					a?.entitlementAvailability === "AVAILABLE" &&
					a?.regionAvailability === "AVAILABLE";
				add({
					item: "5",
					name: `Bedrock ${want} (${region})`,
					status: usable ? "PASS" : "FAIL",
					evidence:
						r.status === 200
							? `${id}: agreement ${a?.agreementAvailability?.status}, authorization ${a?.authorizationStatus}, entitlement ${a?.entitlementAvailability}, region ${a?.regionAvailability}`
							: `${id}: HTTP ${r.status}`,
				});
			}
		} catch (error) {
			add({
				item: "5",
				name: `Bedrock models (${region})`,
				status: "FAIL",
				evidence: errorText(error),
			});
		}
	}
}
{
	let routes: readonly string[] = [];
	try {
		routes = (
			(await import(
				pathToFileURL(join(BRIDGE, "evals/harbor_v2/config.ts")).href
			)) as {
				HARBOR_ROUTES: readonly string[];
			}
		).HARBOR_ROUTES;
	} catch {}
	add({
		item: "5",
		name: "bridge has a Bedrock route (Claude/OpenAI models on Bedrock)",
		status: routes.some((r) => /bedrock/i.test(r)) ? "PASS" : "FAIL",
		evidence: `bridge routes: ${routes.join(", ") || "unreadable"}; a Bedrock arm cannot run without one (docs/harbor-bridge-v2.md "Not verified")`,
	});
}
{
	const fromFile = (path: string | undefined) => {
		if (!path || !existsSync(path)) return {} as Record<string, string>;
		return Object.fromEntries(
			readFileSync(path, "utf8")
				.split("\n")
				.map((line) =>
					line.replace(/^\s*export\s+/, "").match(/^([A-Z0-9_]+)=(.*)$/),
				)
				.filter((m): m is RegExpMatchArray => !!m)
				.map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
		);
	};
	const env: Record<string, string | undefined> = {
		...fromFile(join(repo, ".env")),
		...fromFile(flags["run-env"]),
		...process.env,
	};
	const total = Number(env.YTIMESY_HARBOR_TOTAL_USD_CAP);
	const trial = Number(env.YTIMESY_HARBOR_TRIAL_USD_CAP);
	const ledger = env.YTIMESY_HARBOR_SPEND_LEDGER;
	const ok = total > 0 && trial > 0 && !!ledger && trial <= total;
	add({
		item: "5",
		name: "spend caps set (YTIMESY_HARBOR_TOTAL_USD_CAP, _TRIAL_USD_CAP, _SPEND_LEDGER)",
		status: ok ? "PASS" : "FAIL",
		evidence: `total cap ${Number.isFinite(total) && total > 0 ? `$${total}` : "unset"}, trial cap ${Number.isFinite(trial) && trial > 0 ? `$${trial}` : "unset"}, ledger ${ledger ? "set" : "unset"}${ledger && existsSync(`${ledger}.stop`) ? " (STOP FILE PRESENT)" : ""}; sources: process env, .env${flags["run-env"] ? `, ${flags["run-env"]}` : " (pass --run-env <file>)"}`,
		command: ok
			? undefined
			: "put YTIMESY_HARBOR_TOTAL_USD_CAP / _TRIAL_USD_CAP / _SPEND_LEDGER in the run env file the controller sources, then rerun with --run-env",
	});
}

/* ---------- 6-9 ---------- */

{
	const coordinator = join(repo, "benchmarks/harbor/freestyle-coordinator.ts");
	const source = existsSync(coordinator)
		? readFileSync(coordinator, "utf8")
		: "";
	const ttl = /autoDeleteSeconds\s*:\s*\d|ttlSeconds\s*:\s*\d/.test(source);
	add({
		item: "6",
		name: "run controller on a server/VM (not this laptop), no auto-delete, results copied off",
		status: "MANUAL",
		evidence: `freestyle-coordinator.ts ${source ? (ttl ? "SETS an auto-delete/TTL" : "sets no auto-delete") : "missing"}; this script ran on ${process.platform} (${process.platform === "darwin" ? "laptop: not a controller" : "server"})`,
		command:
			"record the controller VM id, `systemd`/tmux unit, and the R2 sync interval (<= 5 min) in the run notes",
	});
}
add({
	item: "7",
	name: "self-re-arming monitor with alerts; one named owner",
	status: "MANUAL",
	evidence:
		"cron/systemd timer on the controller (not a session reminder); alert on trial end, 20 min log silence, spend threshold, ledger stop",
	command:
		"on the controller: `systemctl list-timers | grep tb4` shows the watcher; kill it once and confirm it restarts",
});
{
	const dir = join(repo, "benchmarks/evaluation");
	const candidates = flags.rule
		? [resolve(flags.rule)]
		: readdirSync(dir)
				.filter(
					(f) =>
						/^tb4-.*\.md$/.test(f) &&
						![
							"tb4-rerun-20261013.md",
							"tb4-harness-audit-20261014.md",
						].includes(f),
				)
				.map((f) => join(dir, f));
	const committed = candidates.filter((path) => {
		try {
			return !!execFileSync(
				"git",
				["-C", repo, "log", "-1", "--format=%h %cI", "--", path],
				{
					encoding: "utf8",
				},
			).trim();
		} catch {
			return false;
		}
	});
	const rule = committed[0];
	const text = rule ? readFileSync(rule, "utf8") : "";
	const parts = ["rerun", "scored", "budget", "attempt"].filter((w) =>
		new RegExp(w, "i").test(text),
	);
	add({
		item: "8",
		name: "scoring rule committed before the first trial",
		status: rule && parts.length === 4 ? "PASS" : "FAIL",
		evidence: rule
			? `${rule.replace(`${repo}/`, "")} committed; mentions ${parts.join(", ")}`
			: "no committed benchmarks/evaluation/tb4-<run>.md for the next run (only the 2026-10-13 rerun rule)",
		command: rule
			? undefined
			: "write and commit benchmarks/evaluation/tb4-<run>.md from docs/tb4-readiness.md item 8",
	});
}
{
	const dry = join(repo, ".ytimesy/tb4-readiness/dry-run");
	const reports = existsSync(dry)
		? readdirSync(dry).filter((f) => /report/i.test(f))
		: [];
	add({
		item: "9",
		name: "3-5 task end-to-end dry run incl. collection and report",
		status: reports.length ? "PASS" : "MANUAL",
		evidence: reports.length
			? `${reports.join(", ")} in ${dry}`
			: `no dry-run report under ${dry}`,
		command: reports.length
			? undefined
			: "run the controller on 3-5 tasks (1 CPU, 1 sidecar, 1 MCP, 1 GPU) end to end, sync to R2, run the scorer, save report to .ytimesy/tb4-readiness/dry-run/",
	});
}

/* ---------- output ---------- */

const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const outDir = join(repo, ".ytimesy/tb4-readiness", stamp);
await mkdir(outDir, { recursive: true });
const counts = { PASS: 0, FAIL: 0, MANUAL: 0 } as Record<Status, number>;
for (const check of checks) counts[check.status]++;
await writeFile(
	join(outDir, "report.json"),
	`${JSON.stringify(
		{
			at: new Date().toISOString(),
			dataset: DATASET,
			bridge: BRIDGE,
			bridgeHead: gitHead(BRIDGE),
			repoHead: gitHead(repo),
			route: flags.route,
			variant: plannedVariant,
			counts,
			checks,
		},
		null,
		2,
	)}\n`,
);
const width = Math.max(...checks.map((c) => c.name.length));
for (const check of checks) {
	console.log(
		`${check.status.padEnd(6)} [${check.item}] ${check.name.padEnd(width)}  ${check.evidence}`,
	);
	if (check.command && check.status !== "PASS")
		console.log(`${" ".repeat(11)}-> ${check.command}`);
}
console.log(
	`\n${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.MANUAL} MANUAL. Gate ${counts.FAIL || counts.MANUAL ? "CLOSED" : "OPEN"}. Report: ${join(outDir, "report.json")}`,
);
process.exit(counts.FAIL ? 1 : 0);
