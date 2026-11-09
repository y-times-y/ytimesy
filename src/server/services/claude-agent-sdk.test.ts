import { afterEach, expect, it, vi } from "vitest";
import { ResumeLater } from "../adapters/resumable-commands";
import {
	CLAUDE_AGENT_SDK_READY_SCRIPT,
	ensureClaudeAgentSdk,
} from "./claude-agent-sdk";

const detached = vi.hoisted(() => vi.fn());
vi.mock("../adapters/freestyle/detached-command", () => ({
	runDetachedCommand: detached,
}));
const shell = vi.fn();
const input = () => ({
	shell,
	turnId: "d5a032bd-83a1-4a13-88ba-5b3592fc6989",
	deadline: Date.now() + 1_000,
	signal: new AbortController().signal,
	redact: () => ["private-test-value"],
});
afterEach(() => vi.resetAllMocks());

it("uses a healthy preinstalled SDK without launching an installer", async () => {
	shell.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
	expect(await ensureClaudeAgentSdk(input())).toBe("ready");
	expect(shell).toHaveBeenCalledExactlyOnceWith(
		CLAUDE_AGENT_SDK_READY_SCRIPT,
		30_000,
	);
	expect(detached).not.toHaveBeenCalled();
});

it("yields while installing and reattaches to the same turn/version on the next step", async () => {
	shell.mockResolvedValue({ exitCode: 78, stdout: "", stderr: "" });
	detached
		.mockRejectedValueOnce(new ResumeLater())
		.mockResolvedValueOnce({ exitCode: 0 });
	expect(await ensureClaudeAgentSdk(input())).toBe("pending");
	expect(await ensureClaudeAgentSdk(input())).toBe("ready");
	expect(detached.mock.calls[0]?.[1]).toMatch(/^[a-f0-9]{64}$/);
	expect(detached.mock.calls[0]?.[1]).toBe(detached.mock.calls[1]?.[1]);
	detached.mockResolvedValueOnce({ exitCode: 0 });
	expect(
		await ensureClaudeAgentSdk({
			...input(),
			turnId: "d5a032bd-83a1-4a13-88ba-5b3592fc6988",
		}),
	).toBe("ready");
	expect(detached.mock.calls[2]?.[1]).not.toBe(detached.mock.calls[0]?.[1]);
});

it("keeps redacted installation diagnostics out of the user-visible failure", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		shell.mockResolvedValue({ exitCode: 78, stdout: "", stderr: "" });
		detached.mockResolvedValue({
			exitCode: 1,
			stdout: "private-test-value registry failure",
			stderr: "token=another-private-value",
		});
		await expect(ensureClaudeAgentSdk(input())).rejects.toThrow(
			"SDK setup failed",
		);
		const log = JSON.stringify(warn.mock.calls);
		expect(log).toContain("registry failure");
		expect(log).not.toContain("private-test-value");
		expect(log).not.toContain("another-private-value");
	} finally {
		warn.mockRestore();
	}
});

it("distinguishes an installation timeout and never hides a platform reset", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		shell.mockResolvedValue({ exitCode: 78, stdout: "", stderr: "" });
		detached.mockResolvedValueOnce({ exitCode: 124, stdout: "", stderr: "" });
		await expect(ensureClaudeAgentSdk(input())).rejects.toThrow(
			"SDK download timed out",
		);
		const reset = new Error(
			"Durable Object's isolate exceeded its memory limit and was reset.",
		);
		detached.mockRejectedValueOnce(reset);
		await expect(ensureClaudeAgentSdk(input())).rejects.toBe(reset);
	} finally {
		warn.mockRestore();
	}
});

it("does no VM work after cancellation", async () => {
	await expect(
		ensureClaudeAgentSdk({
			...input(),
			signal: AbortSignal.abort(new Error("Stopped")),
		}),
	).rejects.toThrow("Stopped");
	expect(shell).not.toHaveBeenCalled();
});
