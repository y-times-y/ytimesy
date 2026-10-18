import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	attemptSections,
	attemptsVerifyScript,
	parseReward,
	setupFiles,
	stageScript,
	type TaskEnvironment,
	verifyScript,
} from "../scripts/hard-set/environment";

const task = {
	id: "demo",
	dir: "/tmp/demo",
	instruction: "Do it.",
	envImage: "env@sha256:1",
	verifierImage: "verifier@sha256:2",
	compose: { services: { main: {} } },
	sidecars: [],
	cpus: 2,
	memoryMb: 2048,
	storageMb: 4096,
	verifierCpus: 2,
	verifierMemoryMb: 2048,
	verifierTimeoutSec: 300,
	verifierEnv: {},
	solutionEnv: {},
	collect: [],
	artifacts: [{ source: "/app", service: "main", exclude: [] }],
	gpus: 0,
	mcpServers: 0,
} as unknown as TaskEnvironment;

describe("hard set: grading each attempt of the loop", () => {
	it("stages and verifies under a name without touching the final grade's paths", () => {
		const stage = stageScript(task, "artifacts-a1");
		expect(stage).toContain("rm -rf /tb/artifacts-a1 /tb/artifacts-a1.tgz");
		expect(stage).toContain(
			"tar -czf /tb/artifacts-a1.tgz -C /tb/artifacts-a1 .",
		);
		expect(stage).not.toMatch(/\/tb\/artifacts(\s|\/|\.tgz)/);
		const verify = verifyScript(task, 300, "artifacts-a1");
		expect(verify).toContain(
			"tar -xzf /tb/artifacts-a1.tgz -C /tb/artifacts-a1",
		);
		expect(verify).toContain("/tb/verifier-out-artifacts-a1/reward.json");
		expect(verify).not.toContain("/tb/verifier-out/");
		// The final grade keeps its original paths.
		expect(stageScript(task)).toContain(
			"tar -czf /tb/artifacts.tgz -C /tb/artifacts .",
		);
		expect(verifyScript(task, 300)).toContain("/tb/verifier-out/reward.json");
	});

	it("grades attempts after the final verify, one section each", () => {
		const script = attemptsVerifyScript(task, 300, [
			"artifacts-a1",
			"artifacts-a2",
		]);
		expect(script.indexOf("/tb/verify.exit")).toBeLessThan(
			script.indexOf("ATTEMPT_BEGIN artifacts-a1"),
		);
		expect(script).toContain("bash /tb/verify-artifacts-a2.sh");
		// Each embedded script is a complete heredoc the shell can parse.
		const dir = mkdtempSync(join(tmpdir(), "hard-set-attempts-"));
		try {
			writeFileSync(join(dir, "s.sh"), script);
			execFileSync("bash", ["-n", join(dir, "s.sh")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const sections = attemptSections(
			[
				"noise",
				"ATTEMPT_BEGIN artifacts-a1",
				'TESTS_EXIT=1\nREWARD_JSON={"reward": 0}',
				"ATTEMPT_END artifacts-a1",
				"ATTEMPT_BEGIN artifacts-a2",
				"TESTS_EXIT=0\nREWARD_TXT=1",
				"ATTEMPT_END artifacts-a2",
			].join("\n"),
		);
		expect(parseReward(sections.get("artifacts-a1") ?? "").reward).toBe(0);
		expect(parseReward(sections.get("artifacts-a2") ?? "").reward).toBe(1);
	});

	it("mounts the checker's scratch and the attempt suites into the task container", () => {
		const setup = Object.values(setupFiles(task, "demo")).join("\n");
		expect(setup).toContain("- /tmp/ytimesy-agents:/tmp/ytimesy-agents");
		expect(setup).toContain("- /tmp/ytimesy-attempts:/tmp/ytimesy-attempts");
		expect(setup).toContain("chmod 1777 /tmp/ytimesy-attempts");
	});
});
