import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { DESKTOP_VIEWER_CREDENTIAL_PATH } from "#/server/adapters/freestyle/start-desktop";
import {
	desktopViewerCredential,
	desktopViewerCredentialDigest,
} from "./vm-edge-keys";
import {
	desktopFromRunningGuest,
	ensureDesktopProcesses,
} from "./workspace-desktop.ts";

vi.stubEnv("BETTER_AUTH_SECRET", "test-root-secret-that-is-long-enough-000");

describe("ensureDesktopProcesses", () => {
	it("reuses the resumed desktop without reinstalling or restarting its dock", async () => {
		const machines = {
			exec: vi.fn().mockResolvedValue({
				exitCode: 0,
				stdout: "YTIMESY_DESKTOP_UP",
				stderr: "",
			}),
			writeTextFile: vi.fn(),
		};
		await ensureDesktopProcesses(machines, "vm-ready");
		expect(machines.exec).toHaveBeenCalledTimes(1);
		expect(machines.writeTextFile).not.toHaveBeenCalled();
	});
	it("still provisions desktop processes when the probe is down", async () => {
		const machines = {
			exec: vi
				.fn()
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: "YTIMESY_DESKTOP_DOWN",
					stderr: "",
				})
				.mockResolvedValueOnce({ exitCode: 0, stdout: "started", stderr: "" }),
			writeTextFile: vi.fn().mockResolvedValue(undefined),
		};
		await ensureDesktopProcesses(machines, "vm-cold");
		expect(machines.exec).toHaveBeenCalledTimes(2);
		expect(machines.exec.mock.calls[0]?.[1]).toContain(
			desktopViewerCredentialDigest("vm-cold"),
		);
		expect(machines.writeTextFile).toHaveBeenCalledTimes(2);
		expect(machines.writeTextFile).toHaveBeenCalledWith(
			"vm-cold",
			DESKTOP_VIEWER_CREDENTIAL_PATH,
			desktopViewerCredential("vm-cold"),
		);
	});
});

describe("desktopFromRunningGuest", () => {
	it("does not start a paused VM to probe Desktop", async () => {
		const commands: string[] = [];
		const desktop = await desktopFromRunningGuest(
			{
				isRunning: async () => false,
				exec: async (_id, command) => {
					commands.push(command);
					return { exitCode: 0, stdout: "YTIMESY_DESKTOP_UP", stderr: "" };
				},
			},
			"vm-paused",
		);
		expect(desktop).toBeNull();
		expect(commands).toEqual([]);
	});

	it("returns a running desktop only when the guest is already up", async () => {
		const desktop = await desktopFromRunningGuest(
			{
				isRunning: async (id) => id === WorkspaceId("vm-live"),
				exec: async () => ({
					exitCode: 0,
					stdout: "YTIMESY_DESKTOP_UP",
					stderr: "",
				}),
			},
			"vm-live",
		);
		expect(desktop?.status).toBe("running");
	});
});
