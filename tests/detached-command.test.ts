import { expect, it, vi } from "vitest";
import { runDetachedCommand } from "../src/server/adapters/freestyle/detached-command";
import { ResumeLater } from "../src/server/adapters/resumable-commands";

const id = "a".repeat(32);
const result = (stdout: string, exitCode = 0) => ({
	exitCode,
	stdout,
	stderr: "",
});

it("starts once, polls until the status file appears and returns the output", async () => {
	const now = Math.floor(Date.now() / 1000);
	const exec = vi
		.fn()
		.mockResolvedValueOnce(result(`${now}\n`))
		.mockResolvedValueOnce(result(""))
		.mockResolvedValueOnce(result("0\n"))
		.mockResolvedValueOnce(result("installed\n"));
	const output = await runDetachedCommand(
		exec,
		id,
		["npm", "ci"],
		{ TOKEN: "s3cr'et" },
		600_000,
		Date.now() + 60_000,
		async () => {},
	);
	expect(output).toEqual(result("installed\n"));
	const start = exec.mock.calls[0][0] as string;
	expect(start).toContain('if [ ! -f "$d/started" ]');
	expect(start).toContain("setsid nohup");
	expect(start).not.toContain("s3cr");
});

it("asks to resume later instead of outliving the invocation budget", async () => {
	const now = Math.floor(Date.now() / 1000);
	const exec = vi
		.fn()
		.mockResolvedValueOnce(result(`${now}\n`))
		.mockResolvedValue(result(""));
	await expect(
		runDetachedCommand(
			exec,
			id,
			["sleep", "3600"],
			{},
			3_600_000,
			Date.now() + 1_000,
			async () => {},
		),
	).rejects.toBeInstanceOf(ResumeLater);
});

it("reports a timeout when the guest never wrote a status", async () => {
	const longAgo = Math.floor(Date.now() / 1000) - 7200;
	const exec = vi
		.fn()
		.mockResolvedValueOnce(result(`${longAgo}\n`))
		.mockResolvedValueOnce(result(""))
		.mockResolvedValueOnce(result("partial"));
	expect(
		await runDetachedCommand(
			exec,
			id,
			["x"],
			{},
			60_000,
			Date.now() + 60_000,
			async () => {},
		),
	).toEqual(result("partial", 124));
});

it("rejects unsafe command ids", async () => {
	await expect(
		runDetachedCommand(
			vi.fn(),
			"../etc",
			["x"],
			{},
			1000,
			Date.now(),
			async () => {},
		),
	).rejects.toThrow("Invalid command id.");
});
