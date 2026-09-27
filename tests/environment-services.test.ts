import { expect, it, vi } from "vitest";
import { WorkspaceId } from "../src/domain/ids";
import { startEnvironmentServices } from "../src/server/services/environment-services";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

it("uses a non-login readiness shell so Ubuntu logout hooks cannot override success", async () => {
	const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
	const machines = {
		readTextFile: async () =>
			JSON.stringify({
				version: 1,
				repositories: [
					{
						repositoryId: 1,
						fullName: "org/web",
						directory: "/home/ubuntu/web",
						commit: "revision",
						recipe: {
							services: [{ name: "web", command: "npm start", port: 3000 }],
						},
					},
				],
			}),
		exec,
	} as unknown as WorkspaceMachines;
	await startEnvironmentServices(machines, WorkspaceId("vm-test"));
	expect(exec).toHaveBeenCalledOnce();
	const command = (exec.mock.calls[0] as unknown as [string, string])[1];
	expect(command.startsWith("bash -c ")).toBe(true);
	expect(command).toContain("tmux has-session");
});

it("does not mistake a provider outage for an environment without services", async () => {
	const machines = {
		readTextFile: async () => {
			throw new Error("offline");
		},
	} as unknown as WorkspaceMachines;
	await expect(
		startEnvironmentServices(machines, WorkspaceId("vm-test")),
	).rejects.toThrow("offline");
});
