import { Effect } from "effect";
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
	readWorkspaceDesktop,
	resolveDesktopRemote,
} from "./workspace-desktop.ts";
import type { WorkspaceMachines } from "./workspace-machines";

vi.mock("#/server/adapters/workspaces", () => ({
	readyWorkspaceForOwner: async () => ({ providerRef: "vm-template" }),
}));
vi.mock("./agent-session-machine", () => ({
	peekAgentSessionMachine: async () => ({
		providerRef: "vm-session",
		session: { id: "s" },
	}),
	bindAgentSessionMachine: async () => ({}),
}));

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

describe("readWorkspaceDesktop", () => {
	it("takes the viewer route down when the chat's machine is asleep", async () => {
		const withdrawHttpRoutes = vi.fn(async () => 1);
		const machines = {
			isRunning: async () => false,
			exec: vi.fn(),
			withdrawHttpRoutes,
		} as unknown as WorkspaceMachines;
		const desktop = await Effect.runPromise(
			readWorkspaceDesktop(machines, {
				userId: "u",
				projectId: "p",
				sessionId: "s",
			}),
		);
		expect(desktop.status).toBe("stopped");
		expect(withdrawHttpRoutes).toHaveBeenCalledWith("vm-session", ["desk"]);
	});

	it("relays to the chat's machine with its viewer credential", async () => {
		const remote = await resolveDesktopRemote({
			userId: "u",
			projectId: "p",
			sessionId: "s2",
		});
		expect(remote).toEqual({
			origin: expect.stringMatching(
				/^https:\/\/ytimesy-desk-[a-f0-9]{24}\.style\.dev$/,
			),
			authorization: `Basic ${Buffer.from(desktopViewerCredential("vm-session")).toString("base64")}`,
		});
	});
});
