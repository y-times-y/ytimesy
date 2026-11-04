import {
	machineGitReleaseScript,
	machineGitSetupScript,
	machineGitTouchScript,
	terminalMachineGitHolder,
} from "#/domain/machine-git";
import { gitProxyConfiguration } from "../adapters/github/git-proxy-transfer";
import { machineGitTokens } from "../adapters/machine-git-tokens";

/** A terminal's token outlives a missed renewal; a closed one is revoked at once. */
export const TERMINAL_TOKEN_TTL_MS = 30 * 60_000;
export const TERMINAL_TOKEN_RENEW_MS = 10 * 60_000;

/** One shell command on the chat's VM. */
export type TerminalVmExec = (
	command: string,
	timeoutMs: number,
) => Promise<{ exitCode: number }>;

export type TerminalMachineGit = {
	/** Revokes the terminal's token and removes it from the VM; idempotent, never fails. */
	stop(): Promise<void>;
};

/**
 * Plain git in the user's terminal on a chat, between turns too: a token
 * held by this terminal connection (its own file beside the turns'), renewed
 * while the terminal is open. Same rules as the agent's git; a push to the
 * default branch is approved from the chat. Null when git stays as it was
 * (no proxy configured, or setup failed).
 */
export async function startTerminalMachineGit(input: {
	userId: string;
	sessionId: string;
	exec: TerminalVmExec;
	tokens?: Pick<typeof machineGitTokens, "mint" | "extend" | "revoke">;
	timers?: {
		repeat(run: () => void, ms: number): unknown;
		clear(handle: unknown): void;
	};
}): Promise<TerminalMachineGit | null> {
	const tokens = input.tokens ?? machineGitTokens;
	const timers = input.timers ?? {
		repeat: (run: () => void, ms: number) => {
			const handle = setInterval(run, ms);
			// A terminal's renewal never keeps the server process alive.
			(handle as { unref?: () => void }).unref?.();
			return handle;
		},
		clear: (handle: unknown) =>
			clearInterval(handle as ReturnType<typeof setInterval>),
	};
	let origin: string;
	try {
		const proxy = gitProxyConfiguration();
		if (!proxy) return null;
		origin = proxy.origin;
	} catch {
		return null;
	}
	const holder = terminalMachineGitHolder(
		input.sessionId,
		Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) =>
			value.toString(16).padStart(2, "0"),
		).join(""),
	);
	let token: string;
	try {
		token = await tokens.mint({
			userId: input.userId,
			sessionId: input.sessionId,
			holder: "terminal",
			expiresAt: new Date(Date.now() + TERMINAL_TOKEN_TTL_MS),
		});
	} catch {
		console.warn("Terminal git token could not be minted.");
		return null;
	}
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		timers.clear(renewal);
		await Promise.all([
			input
				.exec(machineGitReleaseScript(holder), 15_000)
				.catch(() => undefined),
			tokens.revoke(token).catch(() => {
				console.warn(
					"Terminal git token could not be revoked; it expires soon.",
				);
			}),
		]);
	};
	const renewal = timers.repeat(() => {
		void tokens
			.extend(token, new Date(Date.now() + TERMINAL_TOKEN_TTL_MS))
			.then(async (open) => {
				if (!open) return stop();
				await input.exec(machineGitTouchScript(holder), 15_000);
			})
			.catch(() => {
				console.warn("Terminal git token could not be renewed.");
			});
	}, TERMINAL_TOKEN_RENEW_MS);
	try {
		const setup = await input.exec(
			machineGitSetupScript({ origin, holder, token }),
			30_000,
		);
		if (setup.exitCode !== 0) throw new Error(`exit ${setup.exitCode}`);
	} catch {
		console.warn("Terminal git setup failed on the VM.");
		await stop();
		return null;
	}
	return { stop };
}
