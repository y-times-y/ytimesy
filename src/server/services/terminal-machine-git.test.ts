import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	startTerminalMachineGit,
	TERMINAL_TOKEN_RENEW_MS,
	TERMINAL_TOKEN_TTL_MS,
} from "./terminal-machine-git";

const sessionId = "00000000-0000-4000-8000-0000000000aa";
const token = `ygm_${"2".repeat(64)}`;

function harness(exitCode = 0) {
	const tokens = {
		mint: vi.fn(async () => token),
		extend: vi.fn(async () => true),
		revoke: vi.fn(async () => {}),
	};
	const exec = vi.fn(async (_command: string, _timeoutMs: number) => ({
		exitCode,
	}));
	let tick: (() => void) | null = null;
	const timers = {
		repeat: vi.fn((run: () => void, ms: number) => {
			expect(ms).toBe(TERMINAL_TOKEN_RENEW_MS);
			tick = run;
			return "handle";
		}),
		clear: vi.fn(),
	};
	return { tokens, exec, timers, tick: () => tick?.() };
}

describe("startTerminalMachineGit", () => {
	beforeEach(() => {
		vi.stubEnv("YTIMESY_GIT_PROXY_URL", "https://edge.example.test");
		vi.stubEnv("YTIMESY_GIT_PROXY_SECRET", "s".repeat(48));
	});
	afterEach(() => vi.unstubAllEnvs());

	it("puts a terminal-held token in its own file, renews it while open and removes it on close", async () => {
		const { tokens, exec, timers, tick } = harness();
		const git = await startTerminalMachineGit({
			userId: "alice",
			sessionId,
			exec,
			tokens,
			timers,
		});
		expect(tokens.mint).toHaveBeenCalledWith({
			userId: "alice",
			sessionId,
			holder: "terminal",
			expiresAt: expect.any(Date),
		});
		const expiry = (
			tokens.mint.mock.calls[0] as unknown as [{ expiresAt: Date }]
		)[0].expiresAt;
		expect(expiry.getTime() - Date.now()).toBeLessThanOrEqual(
			TERMINAL_TOKEN_TTL_MS,
		);
		const setup = exec.mock.calls[0][0];
		const holder = new RegExp(
			`tokens/(${sessionId}-terminal-[a-f0-9]{16})"`,
		).exec(setup)?.[1];
		expect(holder).toBeTruthy();

		tick();
		await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
		expect(tokens.extend).toHaveBeenCalledWith(token, expect.any(Date));
		expect(exec.mock.calls[1][0]).toContain(`touch -c`);
		expect(exec.mock.calls[1][0]).toContain(holder);

		await git?.stop();
		await git?.stop();
		expect(timers.clear).toHaveBeenCalledWith("handle");
		expect(tokens.revoke).toHaveBeenCalledTimes(1);
		expect(tokens.revoke).toHaveBeenCalledWith(token);
		expect(exec.mock.calls[2][0]).toContain(`rm -f "$d/tokens/${holder}"`);
	});

	it("stops renewing and removes the file once the token is gone server-side", async () => {
		const { tokens, exec, timers, tick } = harness();
		tokens.extend.mockResolvedValueOnce(false);
		await startTerminalMachineGit({
			userId: "alice",
			sessionId,
			exec,
			tokens,
			timers,
		});
		tick();
		await vi.waitFor(() => expect(tokens.revoke).toHaveBeenCalled());
		expect(timers.clear).toHaveBeenCalled();
	});

	it("revokes at once when setup fails on the VM, and is off without the proxy", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failing = harness(1);
		expect(
			await startTerminalMachineGit({
				userId: "alice",
				sessionId,
				exec: failing.exec,
				tokens: failing.tokens,
				timers: failing.timers,
			}),
		).toBeNull();
		expect(failing.tokens.revoke).toHaveBeenCalledWith(token);
		vi.stubEnv("YTIMESY_GIT_PROXY_URL", "");
		const off = harness();
		expect(
			await startTerminalMachineGit({
				userId: "alice",
				sessionId,
				exec: off.exec,
				tokens: off.tokens,
				timers: off.timers,
			}),
		).toBeNull();
		expect(off.tokens.mint).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
