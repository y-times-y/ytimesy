/**
 * Harbor bridge v2 preflight (docs/harbor-bridge-v2.md): for each chosen
 * task, Harbor's own oracle agent (the reference solution) must score 1 and
 * its nop agent (no changes) must score 0 through the real Harbor grader on
 * the same environment, before any agent trial. The outcome is written to a
 * preflight file; the bridge refuses a trial of a task the file does not
 * show as passed (YTIMESY_HARBOR_PREFLIGHT).
 *
 * node --import tsx evals/harbor_v2/preflight.ts --tasks session-window-debug,shadow-relay \
 *   [--env docker] [--jobs-dir .ytimesy/harbor-v2/preflight] [--dry-run]
 *
 * No model is called. Oracle and nop trials spend only environment compute.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./main-module";

export type PreflightArm = "oracle" | "nop";
export type ArmResult = {
	arm: PreflightArm;
	job: string;
	reward: number | null;
	exception: string | null;
};
export type TaskPreflight = {
	task: string;
	passed: boolean;
	reason: string | null;
	arms: ArmResult[];
};
export type PreflightFile = {
	version: 1;
	dataset: string;
	environment: string;
	harbor: string;
	at: string;
	tasks: Record<string, TaskPreflight>;
};

/** The reward of the single trial in a Harbor job directory, from its result.json. */
export async function jobTrialResult(
	jobDirectory: string,
): Promise<{ reward: number | null; exception: string | null }> {
	const trials = (await readdir(jobDirectory, { withFileTypes: true })).filter(
		(entry) => entry.isDirectory() && entry.name.includes("__"),
	);
	if (trials.length !== 1)
		return {
			reward: null,
			exception: `expected one trial in ${jobDirectory}, found ${trials.length}`,
		};
	const result = JSON.parse(
		await readFile(join(jobDirectory, trials[0].name, "result.json"), "utf8"),
	) as {
		verifier_result?: { rewards?: Record<string, unknown> } | null;
		exception_info?: {
			exception_type?: string;
			exception_message?: string;
		} | null;
	};
	const reward = result.verifier_result?.rewards?.reward;
	return {
		reward: typeof reward === "number" ? reward : null,
		exception: result.exception_info
			? `${result.exception_info.exception_type ?? "exception"}: ${(result.exception_info.exception_message ?? "").slice(0, 300)}`
			: null,
	};
}

/** Oracle must score exactly 1 and nop exactly 0, both without an exception. */
export function preflightVerdict(
	task: string,
	arms: ArmResult[],
): TaskPreflight {
	const oracle = arms.find((arm) => arm.arm === "oracle");
	const nop = arms.find((arm) => arm.arm === "nop");
	const problems = [
		!oracle
			? "oracle did not run"
			: oracle.exception
				? `oracle raised ${oracle.exception}`
				: oracle.reward !== 1
					? `oracle scored ${oracle.reward ?? "nothing"} (needs 1)`
					: null,
		!nop
			? "nop did not run"
			: nop.exception
				? `nop raised ${nop.exception}`
				: nop.reward !== 0
					? `nop scored ${nop.reward ?? "nothing"} (needs 0)`
					: null,
	].filter((problem): problem is string => problem !== null);
	return {
		task,
		passed: problems.length === 0,
		reason: problems.length ? problems.join("; ") : null,
		arms,
	};
}

/** The bridge's gate: null when the task may run, else why not. */
export async function preflightRefusal(
	path: string | undefined,
	task: string | undefined,
): Promise<string | null> {
	if (path === "skip") return null;
	if (!path)
		return "No preflight: run evals/harbor_v2/preflight.ts for this task and set YTIMESY_HARBOR_PREFLIGHT (or set it to skip).";
	if (!task)
		return "The trial's task name is unknown; cannot check its preflight.";
	let file: PreflightFile;
	try {
		file = JSON.parse(await readFile(path, "utf8")) as PreflightFile;
	} catch {
		return `The preflight file ${path} cannot be read.`;
	}
	const name = task.replace(/^terminal-bench\//, "");
	const entry = file.tasks?.[name];
	if (!entry) return `${name} has no preflight in ${path}.`;
	return entry.passed ? null : `${name} failed its preflight: ${entry.reason}`;
}

function run(command: string[], log: string) {
	return new Promise<number>((done, fail) => {
		const child = spawn(command[0], command.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.stderr.on("data", (chunk) => chunks.push(chunk));
		child.on("error", fail);
		child.on("close", async (code) => {
			await writeFile(log, Buffer.concat(chunks));
			done(code ?? 1);
		});
	});
}

async function main() {
	const { values } = parseArgs({
		options: {
			tasks: { type: "string" },
			dataset: {
				type: "string",
				default: "terminal-bench/terminal-bench@4.0.0",
			},
			env: { type: "string", default: "docker" },
			"jobs-dir": { type: "string", default: ".ytimesy/harbor-v2/preflight" },
			harbor: { type: "string", default: "uvx --from harbor==0.24.0 harbor" },
			out: { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	const tasks = (values.tasks ?? "")
		.split(",")
		.map((task) => task.trim())
		.filter(Boolean);
	if (!tasks.length) throw new Error("--tasks a,b is required.");
	const jobsDir = resolve(values["jobs-dir"] as string);
	const out = resolve(values.out ?? join(jobsDir, "preflight.json"));
	const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);
	const harbor = (values.harbor as string).split(" ").filter(Boolean);
	const file: PreflightFile = {
		version: 1,
		dataset: values.dataset as string,
		environment: values.env as string,
		harbor: values.harbor as string,
		at: new Date().toISOString(),
		tasks: {},
	};
	try {
		Object.assign(
			file.tasks,
			(JSON.parse(await readFile(out, "utf8")) as PreflightFile).tasks,
		);
	} catch {}
	if (!values["dry-run"]) await mkdir(jobsDir, { recursive: true });
	for (const task of tasks) {
		const arms: ArmResult[] = [];
		for (const arm of ["oracle", "nop"] as const) {
			const job = `pf-${task}-${arm}-${stamp}`;
			const command = [
				...harbor,
				"run",
				"-d",
				values.dataset as string,
				"-i",
				`terminal-bench/${task}`,
				"-a",
				arm,
				"-e",
				values.env as string,
				"-k",
				"1",
				"-n",
				"1",
				"--jobs-dir",
				jobsDir,
				"--job-name",
				job,
			];
			console.log(command.join(" "));
			if (values["dry-run"]) continue;
			const code = await run(command, join(jobsDir, `${job}.log`));
			const result = await jobTrialResult(join(jobsDir, job)).catch(
				(error: Error) => ({
					reward: null,
					exception: `no result (${error.message}); harbor exited ${code}`,
				}),
			);
			arms.push({ arm, job, ...result });
			console.log(
				`${task} ${arm}: reward ${result.reward ?? "none"}${result.exception ? ` (${result.exception})` : ""}`,
			);
		}
		if (values["dry-run"]) continue;
		file.tasks[task] = preflightVerdict(task, arms);
		console.log(
			`${task}: ${file.tasks[task].passed ? "PASSED" : `FAILED - ${file.tasks[task].reason}`}`,
		);
		await writeFile(out, `${JSON.stringify(file, null, 2)}\n`);
	}
	if (!values["dry-run"]) console.log(`Preflight written to ${out}`);
	if (
		Object.values(file.tasks).some(
			(entry) => tasks.includes(entry.task) && !entry.passed,
		)
	)
		process.exitCode = 1;
}

if (isMainModule(import.meta.url, "preflight")) await main();
