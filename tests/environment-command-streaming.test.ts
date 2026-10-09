import { afterEach, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
	exec: vi.fn(),
	open: vi.fn(),
	close: vi.fn(),
}));
vi.mock("freestyle", async (original) => ({
	...(await original<typeof import("freestyle")>()),
	Freestyle: class {
		vms = { ref: () => ({ exec: provider.exec, pty: provider }) };
	},
}));

import { FreestyleWorkspaceRuntime } from "../src/server/adapters/freestyle/workspace-runtime";

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllEnvs();
});

it("streams potentially long setup commands rather than using the HTTP polling executor", async () => {
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	provider.open.mockImplementation(async (options) => {
		options.onData(new TextEncoder().encode("verified"));
		options.onExit(0);
		return { sessionId: 17, detach: vi.fn() };
	});
	const runtime = new FreestyleWorkspaceRuntime("fixture", {
		streamSetupCommands: true,
	});
	expect(
		await runtime.exec("vm", ["bash", "-lc", "npm ci"], { CI: "true" }, 60_000),
	).toEqual({ exitCode: 0, stdout: "verified", stderr: "" });
	expect(provider.exec).not.toHaveBeenCalled();
	expect(provider.open).toHaveBeenCalledOnce();
	expect(provider.close).toHaveBeenCalledWith(17);
});

it("retains the one-call executor for short inspections", async () => {
	vi.stubEnv("YTIMESY_INFRASTRUCTURE_ADMISSION", "false");
	provider.exec.mockResolvedValue({
		statusCode: 7,
		stdout: "",
		stderr: "failed",
	});
	const runtime = new FreestyleWorkspaceRuntime("fixture", {
		streamSetupCommands: true,
	});
	expect(
		await runtime.exec("vm", ["test", "-d", "/workspace"], {}, 15_000),
	).toEqual({ exitCode: 7, stdout: "", stderr: "failed" });
	expect(provider.exec).toHaveBeenCalledOnce();
	expect(provider.open).not.toHaveBeenCalled();
});
