import { describe, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { desktopFromRunningGuest } from "./workspace-desktop.ts";

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
