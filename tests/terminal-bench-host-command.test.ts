import { expect, it, vi } from "vitest";
import { terminalBenchHostCommand } from "../benchmarks/evaluation/terminal-bench-host-command";

it("keeps every transport request within five minutes while preserving a long job's exit and output", async () => {
	const exec = vi
		.fn()
		.mockResolvedValueOnce({ statusCode: 0 })
		.mockResolvedValueOnce({
			statusCode: 0,
			stdout: JSON.stringify({
				exitCode: 7,
				stdout: "checks ran",
				stderr: "actual failure",
			}),
		});
	expect(
		await terminalBenchHostCommand({ exec }, "bash /tests/test.sh", 1810000),
	).toEqual({ exitCode: 7, stdout: "checks ran", stderr: "actual failure" });
	expect(
		exec.mock.calls.every(([options]) => options.timeoutMs <= 300000),
	).toBe(true);
	expect(exec.mock.calls[0][0].command).toContain("1800 bash");
});

it("does not retry an uncertain launch", async () => {
	const exec = vi.fn().mockResolvedValue({ statusCode: 124 });
	await expect(
		terminalBenchHostCommand({ exec }, "true", 600000),
	).rejects.toThrow("launch");
	expect(exec).toHaveBeenCalledTimes(1);
});
