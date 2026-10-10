import { describe, expect, it } from "vitest";
import {
	terminalBenchCompose,
	terminalBenchExecCommand,
	terminalBenchShellPrerequisites,
	terminalBenchTaskSchema,
	terminalBenchVerificationSetup,
} from "../benchmarks/evaluation/terminal-bench-machines";
import { environmentRecipe } from "../src/domain/project-environment";

const image = `fixture/task@sha256:${"a".repeat(64)}`;
const fixture = () =>
	terminalBenchTaskSchema.parse({
		id: "session-window-debug",
		instruction: "Fix the processor.",
		image,
		artifacts: ["/app/app/"],
		compose: { services: { main: { image, command: ["sleep", "infinity"] } } },
		resources: { cpus: 2, memoryMb: 4096, storageMb: 10240 },
		agentTimeoutSeconds: 28800,
		collectCommands: [],
		verifierMode: "separate",
		sourceSha256: "b".repeat(64),
	});

describe("Terminal-Bench task boundary", () => {
	it("installs and exercises ripgrep before model inference", () => {
		expect(terminalBenchShellPrerequisites).toContain(
			"ca-certificates ripgrep",
		);
		expect(terminalBenchShellPrerequisites).toContain("rg --version");
		expect(terminalBenchShellPrerequisites).toContain(
			"rg --fixed-strings --quiet",
		);
	});
	it("preserves the original ten-minute verifier deadline", () => {
		expect(terminalBenchExecCommand("bash /tests/test.sh", 600000)).toContain(
			"'600' 'bash' '-lc'",
		);
	});
	it("preserves the WAL verifier's original thirty-minute deadline", () => {
		expect(terminalBenchExecCommand("bash /tests/test.sh", 1800000)).toContain(
			"'1800' 'bash' '-lc'",
		);
	});
	it("freezes operator checks without mounting a hidden grader", () => {
		const setup = terminalBenchVerificationSetup(
			environmentRecipe.parse({ checks: ["python3 -m compileall -q app"] }),
		);
		expect(setup).toContain("git add -f .ytimesy/environment.json");
		expect(setup).toContain("python3 -m compileall -q app");
		expect(setup).not.toContain("/tests");
		expect(terminalBenchVerificationSetup()).toBe("");
		expect(() =>
			terminalBenchVerificationSetup(environmentRecipe.parse({})),
		).toThrow("explicit check");
	});
	it("retains pinned task sidecars and shared task networking", () => {
		const task = fixture();
		task.compose.services = {
			main: { image, network_mode: "service:warehouse-api" },
			"warehouse-api": {
				image,
				expose: ["4100"],
				healthcheck: { test: ["CMD", "true"] },
			},
		};
		expect(JSON.parse(terminalBenchCompose(task))).toEqual(task.compose);
	});
	it.each([
		"volumes",
		"ports",
		"privileged",
		"build",
		"devices",
		"cap_add",
		"pid",
		"ipc",
		"userns_mode",
		"env_file",
		"secrets",
		"configs",
		"provider",
		"use_api_socket",
	])("rejects %s authority", (key) => {
		const task = fixture();
		(task.compose.services as Record<string, Record<string, unknown>>).main[
			key
		] = true;
		expect(() => terminalBenchCompose(task)).toThrow();
	});
	it.each(["host", "container:external", "service:missing"])(
		"rejects external networking %s",
		(network_mode) => {
			const task = fixture();
			(
				task.compose.services as Record<string, Record<string, unknown>>
			).main.network_mode = network_mode;
			expect(() => terminalBenchCompose(task)).toThrow();
		},
	);
	it("rejects mutable images and top-level host configuration", () => {
		const task = fixture();
		(
			task.compose.services as Record<string, Record<string, unknown>>
		).main.image = "fixture:latest";
		expect(() => terminalBenchCompose(task)).toThrow();
		const other = fixture();
		other.compose.volumes = {};
		expect(() => terminalBenchCompose(other)).toThrow();
	});
	it.each([
		"/etc",
		"/app/../etc",
		"/app/a/../../etc",
		"/app/a\\b",
		"/app/a\0b",
	])("rejects artifact path %s", (path) => {
		expect(() =>
			terminalBenchTaskSchema.parse({ ...fixture(), artifacts: [path] }),
		).toThrow();
	});
	it.each(["/", "/usr", "/var/"])("rejects system directory %s", (path) => {
		expect(() =>
			terminalBenchTaskSchema.parse({ ...fixture(), artifacts: [path] }),
		).toThrow();
	});
	it("accepts task-owned paths and sidecar artifacts in Harbor's form", () => {
		const task = terminalBenchTaskSchema.parse({
			...fixture(),
			artifacts: [
				"/results/output.csv",
				{ source: "/audit/log.jsonl", service: "legacy-app" },
				{ source: "/workspace/app", exclude: ["node_modules"] },
			],
			collectCommands: [{ command: "true", service: "loadgen" }],
			resources: { cpus: 2, memoryMb: 4096, storageMb: 20480 },
		});
		expect(task.artifacts).toEqual([
			{ source: "/results/output.csv", service: "main", exclude: [] },
			{ source: "/audit/log.jsonl", service: "legacy-app", exclude: [] },
			{ source: "/workspace/app", service: "main", exclude: ["node_modules"] },
		]);
	});
	it("allows only ptrace as an added task capability", () => {
		const task = fixture();
		const main = (
			task.compose.services as Record<string, Record<string, unknown>>
		).main;
		main.cap_add = ["SYS_PTRACE"];
		expect(() => terminalBenchCompose(task)).not.toThrow();
		main.cap_add = ["SYS_ADMIN"];
		expect(() => terminalBenchCompose(task)).toThrow();
	});
	it("quotes model shell text inside the isolated container command", () => {
		const command = terminalBenchExecCommand("echo 'hello'; $(id)", 1500);
		expect(command).toContain("'--user' 'root' 'main'");
		expect(command).toContain("'2' 'bash' '-lc'");
		expect(command).not.toContain("docker.sock");
	});
});
