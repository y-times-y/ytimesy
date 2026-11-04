import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { machineGitStep } from "./machine-git";

const SECRET_ENV = "YTIMESY_GIT_PROXY_SECRET";
const owner = {
	userId: "alice",
	id: "00000000-0000-4000-8000-0000000000aa",
};

function fakeTokens() {
	return {
		mint: vi.fn(async () => `ygm_${"1".repeat(64)}`),
		revokeForSession: vi.fn(async () => {}),
	};
}

function workspace(exitCode = 0) {
	const exec = vi.fn(async (_vm: unknown, _command: string) => ({
		exitCode,
		stdout: "",
		stderr: "",
	}));
	return {
		exec,
		ready: { machines: { exec } as never, vm: WorkspaceId("vm-1") },
	};
}

describe("machineGitStep", () => {
	beforeEach(() => {
		vi.stubEnv("YTIMESY_GIT_PROXY_URL", "https://edge.example.test");
		vi.stubEnv(SECRET_ENV, "s".repeat(48));
	});
	afterEach(() => vi.unstubAllEnvs());

	it("is off without the git proxy", () => {
		vi.stubEnv("YTIMESY_GIT_PROXY_URL", "");
		expect(machineGitStep(owner, fakeTokens())).toBeNull();
	});

	it("hands the token to redaction before the VM, sets git up, and releases both at the step's end", async () => {
		const tokens = fakeTokens();
		const step = machineGitStep(owner, tokens);
		const { exec, ready } = workspace();
		const redacted: string[] = [];
		await step?.prepareVm(ready, (token) => {
			redacted.push(token);
			expect(exec).not.toHaveBeenCalled();
		});
		expect(tokens.mint).toHaveBeenCalledWith({
			userId: "alice",
			sessionId: owner.id,
			expiresAt: expect.any(Date),
		});
		expect(redacted).toEqual([`ygm_${"1".repeat(64)}`]);
		const setup = exec.mock.calls[0][1];
		expect(setup).toContain("https://edge.example.test/git/");
		expect(setup).toContain(`tokens/${owner.id}`);
		await step?.releaseVm(ready);
		expect(exec.mock.calls[1][1]).toContain(`rm -f "$d/tokens/${owner.id}"`);
		expect(tokens.revokeForSession).toHaveBeenCalledWith("alice", owner.id);
	});

	it("never fails the step: a failed setup or mint only warns, and release still revokes", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const tokens = fakeTokens();
		tokens.mint.mockRejectedValueOnce(new Error("db down"));
		const step = machineGitStep(owner, tokens);
		const { exec, ready } = workspace(1);
		await expect(step?.prepareVm(ready)).resolves.toBeUndefined();
		expect(exec).not.toHaveBeenCalled();
		await expect(step?.prepareVm(ready)).resolves.toBeUndefined();
		tokens.revokeForSession.mockRejectedValueOnce(new Error("db down"));
		await expect(step?.releaseVm()).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
