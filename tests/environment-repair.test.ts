import { expect, it, vi } from "vitest";
import { parseEnvironmentRepairPlan } from "../src/domain/environment-repair";
import { MemoryWorkspaceRuntime } from "../src/server/adapters/workspace-runtime";
import { installWithEnvironmentRepair } from "../src/server/services/environment-repair";

const failure = { exitCode: 1, stdout: "missing gcc", stderr: "" };
const success = { exitCode: 0, stdout: "", stderr: "" };
function setup() {
	return {
		runtime: new MemoryWorkspaceRuntime(failure),
		vm: "builder",
		command: "npm ci",
		env: { CI: "true" },
		timeoutMs: 1000,
		diagnose: vi.fn(async () =>
			parseEnvironmentRepairPlan('{"action":"retry-install"}'),
		),
		onRepair: vi.fn(async () => {}),
	};
}
it("does not invoke a model for a successful install", async () => {
	const input = setup();
	vi.spyOn(input.runtime, "exec").mockResolvedValue(success);
	await installWithEnvironmentRepair(input);
	expect(input.diagnose).not.toHaveBeenCalled();
});
it("retries the unchanged install and stops after at most two diagnoses", async () => {
	const input = setup();
	await expect(installWithEnvironmentRepair(input)).rejects.toThrow(
		"two attempts",
	);
	expect(input.diagnose).toHaveBeenCalledTimes(2);
	expect(input.runtime.commands).toHaveLength(3);
	expect(
		input.runtime.commands.every((command) => command.argv[2] === "npm ci"),
	).toBe(true);
});
it("applies an allowed tool repair and verifies it by rerunning installation", async () => {
	const input = setup();
	input.diagnose.mockResolvedValue({
		action: "install-packages",
		packages: ["build-essential"],
	});
	const exec = vi
		.spyOn(input.runtime, "exec")
		.mockResolvedValueOnce(failure)
		.mockResolvedValueOnce(success)
		.mockResolvedValueOnce(success);
	await installWithEnvironmentRepair(input);
	expect(exec).toHaveBeenCalledTimes(3);
	expect(exec.mock.calls[1][1][2]).toContain("'build-essential'");
	expect(exec.mock.calls[1][2]).toEqual({});
	expect(exec.mock.calls[2][1][2]).toBe("npm ci");
});
it("does not retry blocked diagnoses or failed repairs", async () => {
	const input = setup();
	input.diagnose.mockResolvedValue({ action: "blocked" });
	await expect(installWithEnvironmentRepair(input)).rejects.toThrow();
	expect(input.runtime.commands).toHaveLength(1);
});
it("rejects arbitrary commands, package flags, and source-edit proposals", () => {
	for (const plan of [
		{ action: "shell", command: "true" },
		{ action: "retry-install", command: "skip-checks" },
		{ action: "install-packages", packages: ["--allow-unauthenticated"] },
		{ action: "install-packages", packages: ["gcc; echo unsafe"] },
	])
		expect(() => parseEnvironmentRepairPlan(JSON.stringify(plan))).toThrow();
});
