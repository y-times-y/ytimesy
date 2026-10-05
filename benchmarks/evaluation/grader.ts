import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationTask } from "#/domain/harness-evaluation";

export async function readFrozenVerifier(task: EvaluationTask) {
	const bytes = await readFile(task.verifier.command[0]);
	if (createHash("sha256").update(bytes).digest("hex") !== task.verifier.sha256)
		throw new Error("Protected verifier differs from its frozen hash.");
	return bytes;
}

/** All grading prerequisites are checked before any paid model request. */
export async function preflightEvaluationGrader(input: {
	repositoryPath: string;
	tasks: readonly EvaluationTask[];
	image: string;
}) {
	const image = await runEvaluatorCommand(
		["docker", "image", "inspect", input.image],
		{ timeoutMs: 15000 },
	);
	if (image.code) throw new Error("Pinned grading image is unavailable.");
	for (const task of input.tasks) {
		await readFrozenVerifier(task);
		const commit = await runEvaluatorCommand(
			["git", "cat-file", "-e", `${task.commit}^{commit}`],
			{ cwd: input.repositoryPath, timeoutMs: 15000 },
		);
		if (commit.code)
			throw new Error(`Pinned grading commit is unavailable: ${task.id}`);
	}
}

export function runEvaluatorCommand(
	command: readonly string[],
	options: { cwd?: string; timeoutMs: number; input?: string },
) {
	return new Promise<{ code: number; stdout: string; stderr: string }>(
		(resolve, reject) => {
			const child = spawn(command[0], command.slice(1), {
				cwd: options.cwd,
				env: {
					PATH: process.env.PATH,
					LANG: "C.UTF-8",
					HOME: options.cwd ?? tmpdir(),
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			const timeout = setTimeout(
				() => child.kill("SIGKILL"),
				options.timeoutMs,
			);
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
				if (stdout.length > 8_000_000) child.kill("SIGKILL");
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
				if (stderr.length > 1_000_000) child.kill("SIGKILL");
			});
			child.on("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(timeout);
				resolve({ code: code ?? 124, stdout, stderr });
			});
			child.stdin.on("error", () => {});
			child.stdin.end(options.input);
		},
	);
}

/** Grade only after agents stop, in a networkless container with no application credentials. */
export async function gradeEvaluationPatches(input: {
	repositoryPath: string;
	task: EvaluationTask;
	patches: readonly string[];
	image: string;
	timeoutMs: number;
}) {
	const bytes = await readFrozenVerifier(input.task);
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-grade-"));
	const container = `ytimesy-grade-${randomUUID()}`;
	try {
		const checkout = join(directory, "checkout");
		const clone = await runEvaluatorCommand(
			[
				"git",
				"-c",
				"core.hooksPath=/dev/null",
				"clone",
				"--no-hardlinks",
				"--no-checkout",
				"--",
				input.repositoryPath,
				checkout,
			],
			{ timeoutMs: 30000 },
		);
		if (clone.code) throw new Error("Cannot create isolated grading checkout.");
		const reset = await runEvaluatorCommand(
			[
				"git",
				"-c",
				"core.hooksPath=/dev/null",
				"checkout",
				"--detach",
				input.task.commit,
			],
			{ cwd: checkout, timeoutMs: 30000 },
		);
		if (reset.code) throw new Error("Pinned grading commit is unavailable.");
		for (const patch of input.patches) {
			const apply = await runEvaluatorCommand(
				["git", "apply", "--index", "--binary", "-"],
				{ cwd: checkout, timeoutMs: 30000, input: patch },
			);
			if (apply.code)
				return {
					passed: false,
					failure: "integration" as const,
					detail: "Reviewed builder patches did not integrate cleanly.",
				};
		}
		const changes = await runEvaluatorCommand(
			["git", "diff", "--cached", "--name-only", "-z", input.task.commit],
			{ cwd: checkout, timeoutMs: 15000 },
		);
		const paths = changes.stdout.split("\0").filter(Boolean);
		if (
			changes.code ||
			paths.some((path) => !input.task.allowedPaths.includes(path))
		)
			return {
				passed: false,
				failure: "scope" as const,
				detail: "Patch changed a protected or unrelated path.",
			};
		// No Git metadata, evaluator host paths, secrets, tests or reference answers enter coding VMs.
		await rm(join(checkout, ".git"), { recursive: true });
		const protectedVerifier = join(directory, "verifier");
		await writeFile(protectedVerifier, bytes, { mode: 0o500 });
		const result = await runEvaluatorCommand(
			[
				"docker",
				"run",
				"--rm",
				"--name",
				container,
				"--network",
				"none",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--pids-limit",
				"256",
				"--cpus",
				"2",
				"--memory",
				"4g",
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,size=256m",
				"--mount",
				`type=bind,source=${checkout},target=/workspace`,
				"--mount",
				`type=bind,source=${protectedVerifier},target=/verifier,readonly`,
				"--workdir",
				"/workspace",
				input.image,
				...input.task.verifier.command.slice(1),
				"/verifier",
			],
			{ timeoutMs: input.timeoutMs },
		);
		return {
			passed: result.code === 0,
			failure: result.code === 0 ? null : ("verifier" as const),
			detail: result.stdout + result.stderr,
			exitCode: result.code,
		};
	} finally {
		await runEvaluatorCommand(["docker", "rm", "-f", container], {
			timeoutMs: 15000,
		}).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
}
