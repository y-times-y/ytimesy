import { describe, expect, it } from "vitest";
import {
	terminalBenchCompose,
	terminalBenchExecCommand,
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
		verifierMode: "separate",
		sourceSha256: "b".repeat(64),
	});

describe("Terminal-Bench task boundary", () => {
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
	it("quotes model shell text inside the isolated container command", () => {
		const command = terminalBenchExecCommand("echo 'hello'; $(id)", 1500);
		expect(command).toContain("'--user' 'root' 'main'");
		expect(command).toContain("'2' 'bash' '-lc'");
		expect(command).not.toContain("docker.sock");
	});
});
