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

it("pins a forked writer to its parent's baseline instead of refusing its non-pristine fork", async () => {
	// fusion-mech-1: the sidekick's fork had committed the parent's tree as
	// its fork base, so HEAD != refs/ytimesy/base and every writer failed
	// "A pristine server-owned verification baseline is required".
	const cwd = await mkdtemp(join(tmpdir(), "yt-baseline-fork-"));
	try {
		const git = (...args: string[]) =>
			run("git", [
				"-C",
				cwd,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				...args,
			]);
		await run("git", ["init", "-q", cwd]);
		await git("commit", "--allow-empty", "-qm", "baseline");
		await git("update-ref", "refs/ytimesy/base", "HEAD");
		const base = (await git("rev-parse", "HEAD")).stdout.trim();
		await writeFile(join(cwd, "lead.txt"), "the lead's uncommitted work");
		await git("add", "-A");
		await git("commit", "-qm", "ytimesy fork base");
		const exec = vi.fn(async (_vm: string, command: string) => {
			try {
				return { ...(await run("bash", ["-lc", command])), exitCode: 0 };
			} catch {
				return { stdout: "", stderr: "", exitCode: 1 };
			}
		});
		const input = {
			cwd,
			vm: "fork",
			userId: "alice",
			sessionId: "writer",
			machines: { exec },
		} as unknown as Parameters<typeof establishVerificationBaselines>[0];
		mocks.pin.mockClear();
		mocks.read.mockImplementation(async (_user: string, session: string) =>
			session === "lead" ? base : null,
		);
		await expect(establishVerificationBaselines(input)).rejects.toThrow(
			"pristine",
		);
		await establishVerificationBaselines({ ...input, forkedFrom: "lead" });
		expect(mocks.pin).toHaveBeenCalledWith("alice", "writer", cwd, base);
		// A parent baseline the fork does not have is refused.
		mocks.pin.mockClear();
		mocks.read.mockImplementation(async (_user: string, session: string) =>
			session === "lead" ? "f".repeat(40) : null,
		);
		await expect(
			establishVerificationBaselines({ ...input, forkedFrom: "lead" }),
		).rejects.toThrow("does not carry");
		expect(mocks.pin).not.toHaveBeenCalled();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
