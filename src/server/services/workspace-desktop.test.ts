import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	desktopFromRunningGuest,
	ensureDesktopProcesses,
} from "./workspace-desktop.ts";

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
		expect(machines.writeTextFile).toHaveBeenCalledTimes(1);
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
