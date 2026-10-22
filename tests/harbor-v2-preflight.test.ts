import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	jobTrialResult,
	type PreflightFile,
	preflightRefusal,
	preflightVerdict,
} from "../evals/harbor_v2/preflight";

let directory: string;
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

async function job(name: string, result: unknown) {
	const trial = join(directory, name, "shadow-relay__AbC123");
	await mkdir(trial, { recursive: true });
	await writeFile(join(trial, "result.json"), JSON.stringify(result));
	return join(directory, name);
}

describe("preflight", () => {
	it("reads the single trial's reward and exception from a Harbor job", async () => {
		directory = await mkdtemp(join(tmpdir(), "harbor-pf-"));
		expect(
			await jobTrialResult(
				await job("oracle", {
					verifier_result: { rewards: { reward: 1 } },
					exception_info: null,
				}),
			),
		).toEqual({ reward: 1, exception: null });
		expect(
			await jobTrialResult(
				await job("broken", {
					verifier_result: null,
					exception_info: {
						exception_type: "VerifierTimeoutError",
						exception_message: "timed out",
					},
				}),
			),
		).toEqual({ reward: null, exception: "VerifierTimeoutError: timed out" });
	});

	it("passes only oracle = 1 and nop = 0, both clean", () => {
		const arm = (
			name: "oracle" | "nop",
			reward: number | null,
			exception: string | null = null,
		) => ({ arm: name, job: `pf-${name}`, reward, exception });
		expect(
			preflightVerdict("shadow-relay", [arm("oracle", 1), arm("nop", 0)]),
		).toMatchObject({ passed: true, reason: null });
		expect(
			preflightVerdict("shadow-relay", [arm("oracle", 0), arm("nop", 0)])
				.reason,
		).toBe("oracle scored 0 (needs 1)");
		expect(
			preflightVerdict("shadow-relay", [arm("oracle", 1), arm("nop", 1)])
				.reason,
		).toBe("nop scored 1 (needs 0)");
		expect(
			preflightVerdict("shadow-relay", [
				arm("oracle", null, "AgentTimeoutError: x"),
			]).reason,
		).toBe("oracle raised AgentTimeoutError: x; nop did not run");
	});

	it("gates a trial on its task's recorded preflight", async () => {
		directory = await mkdtemp(join(tmpdir(), "harbor-pf-"));
		const path = join(directory, "preflight.json");
		const file: PreflightFile = {
			version: 1,
			dataset: "terminal-bench/terminal-bench@4.0.0",
			environment: "docker",
			harbor: "uvx --from harbor==0.24.0 harbor",
			at: "2026-10-18T00:00:00Z",
			tasks: {
				"shadow-relay": {
					task: "shadow-relay",
					passed: true,
					reason: null,
					arms: [],
				},
				"session-window-debug": {
					task: "session-window-debug",
					passed: false,
					reason: "nop scored 1 (needs 0)",
					arms: [],
				},
			},
		};
		await writeFile(path, JSON.stringify(file));
		expect(
			await preflightRefusal(path, "terminal-bench/shadow-relay"),
		).toBeNull();
		expect(
			await preflightRefusal(path, "terminal-bench/session-window-debug"),
		).toMatch(/failed its preflight: nop scored 1/);
		expect(await preflightRefusal(path, "terminal-bench/cad-model")).toMatch(
			/no preflight/,
		);
		expect(
			await preflightRefusal(undefined, "terminal-bench/shadow-relay"),
		).toMatch(/No preflight/);
		expect(await preflightRefusal("skip", undefined)).toBeNull();
	});
});
