import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { establishVerificationBaselines } from "./verification-baseline";

const mocks = vi.hoisted(() => ({ read: vi.fn(), pin: vi.fn() }));
vi.mock("../adapters/turn-verification", () => ({
	readVerificationBaseline: mocks.read,
	pinVerificationBaseline: mocks.pin,
}));
const run = promisify(execFile);

it("pins before execution, reuses the server baseline, and preserves dirty legacy checkouts", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "yt-baseline-"));
	try {
		await run("git", ["init", "-q", cwd]);
		await run("git", [
			"-C",
			cwd,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-qm",
			"baseline",
		]);
		await run("git", ["-C", cwd, "update-ref", "refs/ytimesy/base", "HEAD"]);
		const base = (
			await run("git", ["-C", cwd, "rev-parse", "HEAD"])
		).stdout.trim();
		const exec = vi.fn(async (_vm: string, command: string) => {
			try {
				return { ...(await run("bash", ["-lc", command])), exitCode: 0 };
			} catch {
				return { stdout: "", stderr: "", exitCode: 1 };
			}
		});
		const input = {
			cwd,
			vm: "fixture",
			userId: "alice",
			sessionId: "session",
			machines: { exec },
		} as unknown as Parameters<typeof establishVerificationBaselines>[0];
		mocks.read.mockResolvedValue(null);
		await establishVerificationBaselines(input);
		expect(mocks.pin).toHaveBeenCalledWith("alice", "session", cwd, base);
		await writeFile(join(cwd, "preserved.txt"), "user edits");
		mocks.pin.mockClear();
		exec.mockClear();
		mocks.read.mockResolvedValue(base);
		await establishVerificationBaselines(input);
		expect(exec).not.toHaveBeenCalled();
		expect(mocks.pin).not.toHaveBeenCalled();
		mocks.read.mockResolvedValue(null);
		await expect(establishVerificationBaselines(input)).rejects.toThrow(
			"Existing edits were preserved",
		);
		expect(mocks.pin).not.toHaveBeenCalled();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
